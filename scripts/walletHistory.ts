// On-demand full activity history for a single wallet, without Helius — reads
// straight from Solana RPC (Alchemy free tier), the same balance-delta
// technique already proven for the continuous feed. Unlike the feed this is a
// one-shot, user-triggered page fetch: stateless, paginated by signature
// cursor, so the caller controls how deep into history to go via repeated
// "load more" requests.
//
// IMPORTANT: everything here is computed from THE REQUESTED WALLET's own
// balance deltas, never the fee payer's. getSignaturesForAddress returns
// every transaction that merely MENTIONS the address — including other
// people's swaps where this wallet only received tokens. The first version
// reused the feed's fee-payer-based extractor and silently attributed those
// foreign trades to the wallet being viewed.

import { WSOL, type RawHeliusTx } from "../lib/scannerCore";

const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const USDT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";
const STABLES = new Set([WSOL, USDC, USDT]);

const TX_FETCH_CONCURRENCY = 5; // matches Alchemy free-tier pacing used elsewhere
const TX_FETCH_DELAY_MS = 200;
const MAX_PAGE_SIZE = 100;
const MIN_SOL_TRANSFER = 0.005; // below this a "SOL transfer" is just rent/fee noise

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

// ---------- event extraction (wallet-scoped) ----------

export type WalletEventType = "buy" | "sell" | "token_in" | "token_out" | "sol_in" | "sol_out";

export interface WalletEvent {
  type: WalletEventType;
  ts: number;
  signature: string;
  // token events (buy/sell/token_in/token_out)
  mint?: string;
  symbol?: string;
  tokens?: number;
  // sol events (sol_in/sol_out) and the SOL leg of swaps
  sol?: number;
  // USD value: exact for swaps (the actually-paid SOL/stable leg), and an
  // APPROXIMATION at current market price for token transfers (we have no
  // historical price without a paid API). null = token has no known price.
  usd: number | null;
  usdIsEstimate?: boolean;
  counterparty?: string | null;
  // network fee in SOL, present only when this wallet paid it
  feeSol?: number;
}

// Versioned transactions load extra accounts via address lookup tables;
// pre/postBalances cover static keys AND loaded ones, in this exact order.
function fullAccountKeys(tx: RawHeliusTx): string[] {
  const base = tx.transaction?.message?.accountKeys || [];
  const loaded = tx.meta?.loadedAddresses;
  return [...base, ...(loaded?.writable || []), ...(loaded?.readonly || [])];
}

export function extractWalletEvent(tx: RawHeliusTx, wallet: string, solPrice: number): WalletEvent | null {
  if (tx.meta?.err) return null;

  const keys = fullAccountKeys(tx);
  const walletIdx = keys.indexOf(wallet);
  const isFeePayer = walletIdx === 0;
  const fee = (tx.meta.fee || 0) / 1e9;

  let nativeDelta = 0;
  if (walletIdx >= 0) {
    const pre = tx.meta.preBalances?.[walletIdx];
    const post = tx.meta.postBalances?.[walletIdx];
    if (pre !== undefined && post !== undefined) {
      nativeDelta = (post - pre) / 1e9;
      if (isFeePayer) nativeDelta += fee; // isolate the actual movement from the network fee
    }
  }

  // Per-mint token deltas for accounts OWNED BY THIS WALLET (not the fee payer)
  const preTok = new Map<string, number>();
  for (const t of tx.meta.preTokenBalances || []) {
    if (t.owner !== wallet) continue;
    preTok.set(t.mint, (preTok.get(t.mint) || 0) + (t.uiTokenAmount.uiAmount ?? 0));
  }
  const postTok = new Map<string, number>();
  for (const t of tx.meta.postTokenBalances || []) {
    if (t.owner !== wallet) continue;
    postTok.set(t.mint, (postTok.get(t.mint) || 0) + (t.uiTokenAmount.uiAmount ?? 0));
  }

  let bestMint: string | null = null;
  let bestDelta = 0;
  for (const mint of new Set([...preTok.keys(), ...postTok.keys()])) {
    if (STABLES.has(mint)) continue;
    const delta = (postTok.get(mint) ?? 0) - (preTok.get(mint) ?? 0);
    if (Math.abs(delta) > Math.abs(bestDelta)) { bestDelta = delta; bestMint = mint; }
  }

  const wsolDelta = (postTok.get(WSOL) ?? 0) - (preTok.get(WSOL) ?? 0);
  const solDelta = nativeDelta + wsolDelta;
  const stableDelta =
    ((postTok.get(USDC) ?? 0) - (preTok.get(USDC) ?? 0)) +
    ((postTok.get(USDT) ?? 0) - (preTok.get(USDT) ?? 0));

  const ts = tx.blockTime;
  const signature = tx.transaction?.signatures?.[0] || "";
  const feeSol = isFeePayer ? fee : undefined;

  // 1) Swap: token moved one way, SOL (native or wrapped) the other
  if (bestMint && bestDelta !== 0 && Math.abs(solDelta) >= 0.0005) {
    const side: "buy" | "sell" = solDelta < 0 ? "buy" : "sell";
    if ((side === "buy" && bestDelta > 0) || (side === "sell" && bestDelta < 0)) {
      return { type: side, ts, signature, mint: bestMint, tokens: Math.abs(bestDelta), sol: Math.abs(solDelta), usd: Math.abs(solDelta) * solPrice, feeSol };
    }
  }
  // 1b) Swap via stablecoin leg
  if (bestMint && bestDelta !== 0 && Math.abs(stableDelta) >= 0.5) {
    const side: "buy" | "sell" = stableDelta < 0 ? "buy" : "sell";
    if ((side === "buy" && bestDelta > 0) || (side === "sell" && bestDelta < 0)) {
      return { type: side, ts, signature, mint: bestMint, tokens: Math.abs(bestDelta), usd: Math.abs(stableDelta), feeSol };
    }
  }

  // 2) Token transfer: token moved with no opposing SOL/stable leg.
  //    Counterparty = owner of a token account of the same mint whose balance
  //    moved the opposite way in this same transaction.
  if (bestMint && bestDelta !== 0) {
    const cpDeltas = new Map<string, number>();
    for (const t of tx.meta.preTokenBalances || []) {
      if (t.mint !== bestMint || t.owner === wallet || !t.owner) continue;
      cpDeltas.set(t.owner, (cpDeltas.get(t.owner) || 0) - (t.uiTokenAmount.uiAmount ?? 0));
    }
    for (const t of tx.meta.postTokenBalances || []) {
      if (t.mint !== bestMint || t.owner === wallet || !t.owner) continue;
      cpDeltas.set(t.owner, (cpDeltas.get(t.owner) || 0) + (t.uiTokenAmount.uiAmount ?? 0));
    }
    let counterparty: string | null = null;
    let cpBest = 0;
    for (const [owner, delta] of cpDeltas) {
      // opposite sign to ours, largest magnitude
      if (delta * bestDelta < 0 && Math.abs(delta) > Math.abs(cpBest)) { cpBest = delta; counterparty = owner; }
    }
    return {
      type: bestDelta > 0 ? "token_in" : "token_out",
      ts, signature,
      mint: bestMint,
      tokens: Math.abs(bestDelta),
      usd: null, // filled in later from current market price, if the token has one
      usdIsEstimate: true,
      counterparty,
      feeSol,
    };
  }

  // 3) Pure SOL transfer (no token movement at all)
  if (Math.abs(solDelta) >= MIN_SOL_TRANSFER) {
    // Counterparty: the account whose native balance moved the opposite way
    // the most. System-program transfers only move the two endpoints.
    let counterparty: string | null = null;
    let cpBest = 0;
    for (let i = 0; i < keys.length; i++) {
      if (i === walletIdx) continue;
      const pre = tx.meta.preBalances?.[i];
      const post = tx.meta.postBalances?.[i];
      if (pre === undefined || post === undefined) continue;
      const delta = (post - pre) / 1e9;
      if (delta * solDelta < 0 && Math.abs(delta) > Math.abs(cpBest)) { cpBest = delta; counterparty = keys[i]; }
    }
    return {
      type: solDelta > 0 ? "sol_in" : "sol_out",
      ts, signature,
      sol: Math.abs(solDelta),
      usd: Math.abs(solDelta) * solPrice,
      counterparty,
      feeSol,
    };
  }

  return null;
}

// ---------- historical SOL prices ----------
//
// Valuing a week-old trade at TODAY's SOL price quietly distorts every dollar
// figure by however much SOL moved since — the deeper the history page, the
// worse. CoinGecko's free daily series fixes that at zero cost; anything it
// doesn't cover falls back to the current price.

let dailySolPrices: Map<string, number> | null = null;
let dailySolFetchedAt = 0;

async function getDailySolPrices(): Promise<Map<string, number> | null> {
  if (dailySolPrices && Date.now() - dailySolFetchedAt < 12 * 3600 * 1000) return dailySolPrices;
  try {
    const r = await fetch(
      "https://api.coingecko.com/api/v3/coins/solana/market_chart?vs_currency=usd&days=365&interval=daily",
      { signal: AbortSignal.timeout(10_000) }
    );
    if (!r.ok) return dailySolPrices; // keep stale cache over nothing
    const d = await r.json();
    const map = new Map<string, number>();
    for (const [ms, price] of (d.prices || []) as [number, number][]) {
      map.set(new Date(ms).toISOString().slice(0, 10), price);
    }
    if (map.size > 0) {
      dailySolPrices = map;
      dailySolFetchedAt = Date.now();
    }
  } catch { /* keep stale cache */ }
  return dailySolPrices;
}

function solPriceAt(ts: number, daily: Map<string, number> | null, fallback: number): number {
  if (!daily) return fallback;
  return daily.get(new Date(ts * 1000).toISOString().slice(0, 10)) ?? fallback;
}

// ---------- token metadata (symbol + current price) ----------

const tokenMetaCache = new Map<string, { symbol: string; price: number | null }>();

async function resolveTokenMeta(mints: string[]): Promise<Map<string, { symbol: string; price: number | null }>> {
  const unknown = mints.filter((m) => !tokenMetaCache.has(m));
  for (let i = 0; i < unknown.length; i += 30) {
    try {
      const chunk = unknown.slice(i, i + 30).join(",");
      const r = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${chunk}`, { signal: AbortSignal.timeout(8000) });
      if (!r.ok) continue;
      const d = await r.json();
      const best = new Map<string, { symbol: string; price: number | null; liq: number }>();
      for (const p of (d.pairs || []) as { baseToken?: { address?: string; symbol?: string }; priceUsd?: string; liquidity?: { usd?: number } }[]) {
        const addr = p.baseToken?.address;
        if (!addr || !p.baseToken?.symbol) continue;
        const liq = p.liquidity?.usd || 0;
        const cur = best.get(addr);
        if (!cur || liq > cur.liq) {
          best.set(addr, { symbol: p.baseToken.symbol, price: parseFloat(p.priceUsd || "0") || null, liq });
        }
      }
      for (const [addr, meta] of best) tokenMetaCache.set(addr, { symbol: meta.symbol, price: meta.price });
    } catch { /* ignore — unresolved mints fall back to a shortened address */ }
  }
  const out = new Map<string, { symbol: string; price: number | null }>();
  for (const m of mints) {
    out.set(m, tokenMetaCache.get(m) || { symbol: m.slice(0, 4) + "..." + m.slice(-4), price: null });
  }
  return out;
}

// ---------- page fetch ----------

export interface WalletHistoryPage {
  events: WalletEvent[];
  nextBefore: string | null;
  hasMore: boolean;
  rawTxCount: number;
  failedTxCount: number;
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

  // The continuous feed shares this same Alchemy key, so a 429 here is
  // routine contention, not a dead end — retry instead of failing the page.
  let sigs: SigEntry[] = [];
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      sigs = (await rpcCall(rpcUrl, "getSignaturesForAddress", params)) as SigEntry[];
      break;
    } catch (e) {
      if ((e as { rateLimited?: boolean }).rateLimited && attempt < 3) {
        await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
        continue;
      }
      throw e;
    }
  }
  if (!Array.isArray(sigs) || sigs.length === 0) {
    return { events: [], nextBefore: null, hasMore: false, rawTxCount: 0, failedTxCount: 0 };
  }

  const validSigs = sigs.filter((s) => !s.err).map((s) => s.signature);
  const events: WalletEvent[] = [];
  let failedTxCount = sigs.length - validSigs.length;

  // getSignaturesForAddress is cheap; getTransaction is where the real RPC
  // cost is. We don't know ahead of time what each transaction is — fetch
  // every one and classify it from the wallet's own balance deltas.
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
      if (!tx) { failedTxCount++; continue; }
      const ev = extractWalletEvent(tx, wallet, solPrice);
      if (!ev) continue;
      // drop swap dust; transfers are kept regardless (their USD is often unknown)
      if ((ev.type === "buy" || ev.type === "sell") && (ev.usd ?? 0) < 1) continue;
      events.push(ev);
    }

    if (i + TX_FETCH_CONCURRENCY < validSigs.length) {
      await new Promise((r) => setTimeout(r, TX_FETCH_DELAY_MS));
    }
  }

  // Re-value every SOL-legged event at the SOL price of ITS day, not
  // today's — for old history the difference compounds into real distortion.
  const daily = await getDailySolPrices();
  if (daily) {
    for (const ev of events) {
      if (ev.sol !== undefined) ev.usd = ev.sol * solPriceAt(ev.ts, daily, solPrice);
    }
  }

  // Symbols for every token event + approximate USD for transfers at the
  // token's CURRENT price (clearly flagged as an estimate downstream).
  const mints = Array.from(new Set(events.filter((e) => e.mint).map((e) => e.mint!)));
  const meta = await resolveTokenMeta(mints);
  for (const ev of events) {
    if (!ev.mint) continue;
    const m = meta.get(ev.mint)!;
    ev.symbol = m.symbol;
    if ((ev.type === "token_in" || ev.type === "token_out") && m.price && ev.tokens) {
      ev.usd = ev.tokens * m.price;
    }
  }

  events.sort((a, b) => b.ts - a.ts);

  // Oldest signature in this page becomes the cursor for the next (older)
  // page. A page shorter than the requested limit means we reached the very
  // start of the wallet's on-chain history.
  return {
    events,
    nextBefore: sigs[sigs.length - 1].signature,
    hasMore: sigs.length === limit,
    rawTxCount: sigs.length,
    failedTxCount,
  };
}
