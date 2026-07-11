// Swap collection via a dedicated RPC provider (Alchemy free tier), polling
// instead of streaming. Their free plan's WebSocket endpoint accepts a
// connection but rejects every pubsub subscription method (logsSubscribe,
// accountSubscribe, etc. all return "method not found") — subscriptions are
// evidently a paid-plan feature there. Plain HTTP RPC works fine on the free
// tier though, so we poll getSignaturesForAddress per program on an interval
// and fetch full transactions for whatever's new since the last poll.
//
// This trades a few seconds of latency (vs. instant push) for something that
// actually works within a free plan's real constraints.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import type { RawHeliusTx } from "../lib/scannerCore";

// 30s (was 15s): halves the standing getSignaturesForAddress load. For
// candidate discovery a swap being noticed 30s later changes nothing, and
// RPC compute units are the actual scarce resource here — the feed's
// getTransaction volume was on track to exhaust Alchemy's monthly free cap.
const POLL_INTERVAL_MS = 30_000;
const SIG_LIMIT = 40; // per address per poll — if it produces more than this in one interval, we miss the overflow
const MAX_TX_FETCH_PER_SEC = 5;
const ADDRESS_STAGGER_MS = 800; // spacing between getSignaturesForAddress calls within one poll cycle
const MAX_SIG_RETRIES = 2;

export interface FeedStats {
  connected: boolean;
  queued: number;
  fetched: number;
  dropped: number;
  errors: number;
  rateLimited: number;
  reconnects: number;
  backoffUntil: number;
  polls: number;
  overlapsSkipped: number;
}

interface SigEntry { signature: string; err: unknown | null }

// ---------- multi-endpoint RPC pool with failover ----------
//
// One free-tier provider is a single point of failure: when Alchemy starts
// returning 429/401 (per-second throttle or the monthly compute-unit cap),
// everything built on it goes blind at once. The pool spreads calls across
// endpoints round-robin (even per-second AND monthly usage with many keys),
// puts a misbehaving one on a cooldown, and transparently retries the call
// on the next. A per-endpoint daily call cap keeps a long outage of the
// others from silently draining a capped provider's budget (Helius standard
// RPC spends the same credits the discovery scans need).

export interface RpcEndpoint {
  name: string;
  url: string;
  dailyLimit?: number;
}

export interface RpcPool {
  call: (method: string, params: unknown[], timeoutMs?: number) => Promise<unknown>;
  status: () => { name: string; usedToday: number; dailyLimit: number | null; cooldownForSec: number }[];
}

const ENDPOINT_COOLDOWN_MS = 90_000;

export function makeRpcPool(endpoints: RpcEndpoint[]): RpcPool {
  const cooldownUntil = new Map<string, number>();
  const usedToday = new Map<string, number>();
  let dayResetAt = Date.now() + 24 * 3600 * 1000;
  // Round-robin start position. Strict priority order made the first live
  // endpoint absorb ALL traffic (and all the throttling) while the rest sat
  // idle — with many keys the whole point is spreading per-second load and
  // monthly usage evenly across them.
  let rrIndex = 0;

  async function rawCall(url: string, method: string, params: unknown[], timeoutMs: number): Promise<unknown> {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status === 429 || res.status === 401 || res.status === 403) {
      // 401/403 show up when a provider's plan limit trips, not just bad
      // keys — treat all three as "this endpoint needs a rest".
      const err = new Error(`limited_${res.status}`) as Error & { rateLimited: true };
      err.rateLimited = true;
      throw err;
    }
    if (!res.ok) throw new Error(`http_${res.status}`);
    const data = await res.json();
    if (data.error) throw new Error(data.error.message || "rpc_error");
    return data.result;
  }

  async function call(method: string, params: unknown[], timeoutMs = 10_000): Promise<unknown> {
    if (Date.now() > dayResetAt) {
      usedToday.clear();
      dayResetAt = Date.now() + 24 * 3600 * 1000;
    }
    let lastErr: unknown = null;
    const start = rrIndex++;
    for (let i = 0; i < endpoints.length; i++) {
      const ep = endpoints[(start + i) % endpoints.length];
      if (Date.now() < (cooldownUntil.get(ep.name) || 0)) continue;
      if (ep.dailyLimit && (usedToday.get(ep.name) || 0) >= ep.dailyLimit) continue;
      usedToday.set(ep.name, (usedToday.get(ep.name) || 0) + 1);
      try {
        return await rawCall(ep.url, method, params, timeoutMs);
      } catch (e) {
        lastErr = e;
        if ((e as { rateLimited?: boolean }).rateLimited) {
          cooldownUntil.set(ep.name, Date.now() + ENDPOINT_COOLDOWN_MS);
          continue; // next endpoint picks this call up immediately
        }
        throw e; // genuine RPC error — not the endpoint's health, don't rotate
      }
    }
    // Every endpoint is cooling down or capped
    const err = (lastErr as Error) || new Error("all_endpoints_limited");
    (err as Error & { rateLimited?: boolean }).rateLimited = true;
    throw err;
  }

  return {
    call,
    status: () =>
      endpoints.map((ep) => ({
        name: ep.name,
        usedToday: usedToday.get(ep.name) || 0,
        dailyLimit: ep.dailyLimit ?? null,
        cooldownForSec: Math.max(0, Math.round(((cooldownUntil.get(ep.name) || 0) - Date.now()) / 1000)),
      })),
  };
}

export function startSolanaFeed(
  pool: RpcPool,
  getAddresses: () => string[],
  onSwap: (tx: RawHeliusTx) => void,
  // Where to persist the per-address "last seen signature" cursors. Without
  // this, every restart re-fetched the latest SIG_LIMIT transactions per
  // address and re-emitted swaps the consumer had already recorded —
  // double-counting recent activity in anything persisted downstream.
  statePath?: string
): FeedStats {
  const stats: FeedStats = {
    connected: true, queued: 0, fetched: 0, dropped: 0, errors: 0,
    rateLimited: 0, reconnects: 0, backoffUntil: 0, polls: 0, overlapsSkipped: 0,
  };

  const lastSignature = new Map<string, string>();
  if (statePath && existsSync(statePath)) {
    try {
      const saved = JSON.parse(readFileSync(statePath, "utf-8")) as Record<string, string>;
      for (const [addr, sig] of Object.entries(saved)) lastSignature.set(addr, sig);
    } catch { /* corrupt state file — start fresh */ }
  }
  let cursorsDirty = false;

  function saveCursors() {
    if (!statePath || !cursorsDirty) return;
    try {
      writeFileSync(statePath, JSON.stringify(Object.fromEntries(lastSignature)));
      cursorsDirty = false;
    } catch { /* disk hiccup — retry next cycle */ }
  }

  const txQueue: string[] = [];
  const sigRetries = new Map<string, number>();
  let draining = false;
  let polling = false;
  let consecutive429 = 0;

  async function drainQueue() {
    if (draining) return;
    draining = true;
    try {
      while (txQueue.length > 0) {
        if (Date.now() < stats.backoffUntil) break;
        const batch = txQueue.splice(0, MAX_TX_FETCH_PER_SEC);
        await Promise.all(batch.map(async (sig) => {
          try {
            const tx = await pool.call("getTransaction", [sig, { encoding: "json", maxSupportedTransactionVersion: 0, commitment: "confirmed" }]);
            if (tx) { stats.fetched++; onSwap(tx as RawHeliusTx); }
            sigRetries.delete(sig);
          } catch (e) {
            // A failed fetch used to lose the signature forever; requeue a
            // couple of times so transient errors don't drop real swaps.
            const attempts = (sigRetries.get(sig) || 0) + 1;
            if ((e as { rateLimited?: boolean }).rateLimited) {
              consecutive429++;
              stats.rateLimited++;
              stats.backoffUntil = Date.now() + Math.min(consecutive429 * 10_000, 120_000);
              txQueue.push(sig); // 429 isn't the signature's fault — always retry after backoff
            } else {
              stats.errors++;
              if (attempts === 1) console.error(`[solanaFeed] getTransaction(${sig.slice(0, 8)}) failed: ${(e as Error).message}`);
              if (attempts <= MAX_SIG_RETRIES) {
                sigRetries.set(sig, attempts);
                txQueue.push(sig);
              } else {
                sigRetries.delete(sig);
                stats.dropped++;
              }
            }
          }
        }));
        stats.queued = txQueue.length;
        if (Date.now() >= stats.backoffUntil) consecutive429 = 0;
        await new Promise((r) => setTimeout(r, 1000));
      }
    } finally {
      draining = false;
    }
  }

  async function pollProgram(address: string) {
    try {
      const params: [string, Record<string, unknown>] = [address, { limit: SIG_LIMIT }];
      const until = lastSignature.get(address);
      if (until) params[1].until = until;

      const result = await pool.call("getSignaturesForAddress", params) as SigEntry[];
      if (!Array.isArray(result) || result.length === 0) return;

      lastSignature.set(address, result[0].signature); // newest-first
      cursorsDirty = true;
      const fresh = result.filter((e) => !e.err).map((e) => e.signature);

      for (const sig of fresh) {
        if (txQueue.length >= 200) { stats.dropped++; continue; }
        txQueue.push(sig);
      }
      stats.queued = txQueue.length;
    } catch (e) {
      if ((e as { rateLimited?: boolean }).rateLimited) {
        stats.rateLimited++;
      } else {
        stats.errors++;
        // Errors used to be silently swallowed into a bare counter — finding
        // this exact bug (missing env var → every request 401ing) took
        // digging through raw pm2 env output instead of the logs, because
        // nothing here ever printed WHY. Keep a one-line reason visible.
        console.error(`[solanaFeed] pollProgram(${address.slice(0, 8)}) failed: ${(e as Error).message}`);
      }
    }
  }

  async function pollCycle() {
    // setInterval keeps firing on schedule regardless of how long a cycle
    // takes; with enough watched addresses one cycle (~0.8s each) outlives
    // the 15s interval, and overlapping cycles would compound the request
    // rate into self-inflicted rate limiting. Skip the tick instead.
    if (polling) { stats.overlapsSkipped++; return; }
    polling = true;
    try {
      stats.polls++;
      if (Date.now() < stats.backoffUntil) return;
      const addresses = getAddresses();
      for (const addr of addresses) {
        await pollProgram(addr);
        await new Promise((r) => setTimeout(r, ADDRESS_STAGGER_MS));
      }
      saveCursors();
      drainQueue();
    } finally {
      polling = false;
    }
  }

  pollCycle();
  setInterval(pollCycle, POLL_INTERVAL_MS);

  return stats;
}
