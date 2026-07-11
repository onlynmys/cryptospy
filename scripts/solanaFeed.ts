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

const POLL_INTERVAL_MS = 15_000;
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

async function rpcCall(rpcUrl: string, method: string, params: unknown[]): Promise<unknown> {
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(10_000),
  });
  if (res.status === 429) {
    const err = new Error("rate_limited") as Error & { rateLimited: true };
    err.rateLimited = true;
    throw err;
  }
  if (!res.ok) throw new Error(`http_${res.status}`);
  const data = await res.json();
  if (data.error) throw new Error(data.error.message || "rpc_error");
  return data.result;
}

export function startSolanaFeed(
  rpcUrl: string,
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
            const tx = await rpcCall(rpcUrl, "getTransaction", [sig, { encoding: "json", maxSupportedTransactionVersion: 0, commitment: "confirmed" }]);
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

      const result = await rpcCall(rpcUrl, "getSignaturesForAddress", params) as SigEntry[];
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
