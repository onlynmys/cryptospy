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

import type { RawHeliusTx } from "../lib/scannerCore";

const POLL_INTERVAL_MS = 15_000;
const SIG_LIMIT = 40; // per address per poll — if it produces more than this in one interval, we miss the overflow
const MAX_TX_FETCH_PER_SEC = 5;
const ADDRESS_STAGGER_MS = 800; // spacing between getSignaturesForAddress calls within one poll cycle

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
  onSwap: (tx: RawHeliusTx) => void
): FeedStats {
  const stats: FeedStats = {
    connected: true, queued: 0, fetched: 0, dropped: 0, errors: 0,
    rateLimited: 0, reconnects: 0, backoffUntil: 0, polls: 0,
  };

  const lastSignature = new Map<string, string>();
  const txQueue: string[] = [];
  let draining = false;
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
          } catch (e) {
            if ((e as { rateLimited?: boolean }).rateLimited) {
              consecutive429++;
              stats.rateLimited++;
              stats.backoffUntil = Date.now() + Math.min(consecutive429 * 10_000, 120_000);
            } else {
              stats.errors++;
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
      }
    }
  }

  async function pollCycle() {
    stats.polls++;
    if (Date.now() < stats.backoffUntil) return;
    const addresses = getAddresses();
    for (const addr of addresses) {
      await pollProgram(addr);
      await new Promise((r) => setTimeout(r, ADDRESS_STAGGER_MS));
    }
    drainQueue();
  }

  pollCycle();
  setInterval(pollCycle, POLL_INTERVAL_MS);

  return stats;
}
