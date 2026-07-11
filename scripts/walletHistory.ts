// On-demand full trade history for a single wallet, without Helius — reads
// straight from Solana RPC (Alchemy free tier), the same balance-delta
// technique already proven for the continuous feed (see extractSwapFromRaw).
// Unlike the background feed this is a one-shot, user-triggered page fetch:
// stateless, paginated by signature cursor, so the caller controls how deep
// into history to go via repeated "load more" requests instead of us running
// an unbounded background job.

import { extractSwapFromRaw, resolveSymbols, type RawHeliusTx, type RawExtractedSwap } from "../lib/scannerCore";

const TX_FETCH_CONCURRENCY = 5; // matches Alchemy free-tier pacing used elsewhere
const TX_FETCH_DELAY_MS = 200;
const MAX_PAGE_SIZE = 100;

interface SigEntry { signature: string; err: unknown | null }

async function rpcCall(rpcUrl: string, method: string, params: unknown[], timeoutMs = 10_000): Promise<unknown> {
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(timeoutMs),
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

export interface WalletHistoryPage {
  trades: (RawExtractedSwap & { symbol: string })[];
  nextBefore: string | null;
  hasMore: boolean;
  rawTxCount: number;
}

export async function fetchWalletHistoryPage(
  rpcUrl: string,
  wallet: string,
  before: string | undefined,
  solPrice: number,
  pageSize: number
): Promise<WalletHistoryPage> {
  const limit = Math.min(Math.max(pageSize || 50, 1), MAX_PAGE_SIZE);
  const params: [string, Record<string, unknown>] = [wallet, { limit }];
  if (before) params[1].before = before;

  const sigs = (await rpcCall(rpcUrl, "getSignaturesForAddress", params)) as SigEntry[];
  if (!Array.isArray(sigs) || sigs.length === 0) {
    return { trades: [], nextBefore: null, hasMore: false, rawTxCount: 0 };
  }

  const validSigs = sigs.filter((s) => !s.err).map((s) => s.signature);
  const swaps: RawExtractedSwap[] = [];

  // getSignaturesForAddress is cheap; getTransaction is where the real RPC
  // cost is. We don't know ahead of time which of these are swaps (no more
  // Helius type=SWAP filter to lean on) — fetch every one and let
  // extractSwapFromRaw classify it, same as the continuous feed does.
  for (let i = 0; i < validSigs.length; i += TX_FETCH_CONCURRENCY) {
    const batch = validSigs.slice(i, i + TX_FETCH_CONCURRENCY);
    const results = await Promise.all(
      batch.map(async (sig) => {
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            return (await rpcCall(rpcUrl, "getTransaction", [
              sig,
              { encoding: "json", maxSupportedTransactionVersion: 0, commitment: "confirmed" },
            ])) as RawHeliusTx | null;
          } catch (e) {
            if ((e as { rateLimited?: boolean }).rateLimited) {
              await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
              continue;
            }
            return null;
          }
        }
        return null;
      })
    );

    for (const tx of results) {
      if (!tx) continue;
      const swap = extractSwapFromRaw(tx, solPrice);
      if (swap && swap.usd >= 1) swaps.push(swap);
    }

    if (i + TX_FETCH_CONCURRENCY < validSigs.length) {
      await new Promise((r) => setTimeout(r, TX_FETCH_DELAY_MS));
    }
  }

  const symbols = await resolveSymbols(Array.from(new Set(swaps.map((s) => s.mint))));
  const trades = swaps
    .map((s) => ({ ...s, symbol: symbols.get(s.mint) || s.mint.slice(0, 4) + "..." + s.mint.slice(-4) }))
    .sort((a, b) => b.ts - a.ts);

  // Oldest signature in this page becomes the cursor for the next (older)
  // page. A page shorter than the requested limit means we reached the very
  // start of the wallet's on-chain history.
  return {
    trades,
    nextBefore: sigs[sigs.length - 1].signature,
    hasMore: sigs.length === limit,
    rawTxCount: sigs.length,
  };
}
