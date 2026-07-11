// Shared scanning engine used by both:
//  - app/api/scanner/route.ts (manual scan triggered from the website, runs on Vercel)
//  - scripts/discovery-server.ts (automated scan triggered by an external cron every ~30min,
//    runs persistently on our own VM so results can be written to a local file)
//
// Kept dependency-free from Next.js so it can run in either environment unchanged.

export const DEX = "https://api.dexscreener.com";
export const HELIUS = "https://api.helius.xyz/v0";
export const WSOL = "So11111111111111111111111111111111111111112";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const USDT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";
const STABLES = new Set([WSOL, USDC, USDT]);

// Global swap feeds — DEX program addresses (any pair, any token).
// Pulling from many programs at once = a broad, unbiased sample of ALL Solana traders,
// not just whoever happens to be trending pairs. Kept as the "full" reference
// list even though the free feed below only watches a subset of it.
export const DEX_SOURCES = [
  { name: "Jupiter", address: "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4" },
  { name: "Raydium AMM", address: "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8" },
  { name: "Raydium CLMM", address: "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK" },
  { name: "PumpSwap", address: "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA" },
  { name: "Pump.fun", address: "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P" },
  { name: "Orca Whirlpool", address: "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc" },
  { name: "Meteora DLMM", address: "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo" },
];

// Free public Solana RPC can't keep up with all 7 (measured: subscribing to
// all of them dropped 13,720 of 13,740 matched transactions in ~90 seconds —
// Jupiter and PumpSwap alone produce far more volume than a single shared,
// rate-limited endpoint can fetch full transactions for). Trimmed to the
// quieter programs so we actually capture a usable fraction of what we see.
export const FREE_FEED_SOURCES = [
  { name: "Raydium CLMM", address: "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK" },
  { name: "Orca Whirlpool", address: "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc" },
  { name: "Meteora DLMM", address: "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo" },
];

export interface ScanFilters {
  minWinRate: number;
  minPnlUsd: number;
  maxInactiveHours: number;
  minTrades: number;
}

export const DEFAULT_FILTERS: ScanFilters = { minWinRate: 60, minPnlUsd: 800, maxInactiveHours: 6, minTrades: 1 };

export interface TokenPositionInfo {
  mint: string;
  symbol: string;
  buyUsd: number;
  sellUsd: number;
  pnlUsd: number;
  pnlPct: number;
  buyCount: number;
  sellCount: number;
  holdMinutes: number;
  lastTs: number;
  status: "closed" | "open";
}

export interface SmartWallet {
  address: string;
  winRate: number;
  totalPnlUsd: number;
  totalTrades: number;
  wins: number;
  losses: number;
  avgBuyUsd: number;
  avgHoldMinutes: number;
  lastActivity: number;
  firstActivity: number;
  totalBuyVolumeUsd: number;
  totalSellVolumeUsd: number;
  openPositions: number;
  bestTrade: { symbol: string; pnlUsd: number; pnlPct: number } | null;
  worstTrade: { symbol: string; pnlUsd: number; pnlPct: number } | null;
  score: number;
  tags: string[];
  recentBuys: RecentBuy[];
  positions: TokenPositionInfo[];
}

export interface RecentBuy {
  tokenSymbol: string;
  tokenAddress: string;
  pairAddress: string;
  buyAmountUsd: number;
  buyTime: number;
  priceChangeAfter?: number;
  status: "holding" | "sold_profit" | "sold_loss";
}

export interface HeliusTx {
  signature: string;
  timestamp: number;
  feePayer: string;
  type: string;
  tokenTransfers?: { mint: string; fromUserAccount: string; toUserAccount: string; tokenAmount: number }[];
  nativeTransfers?: { fromUserAccount: string; toUserAccount: string; amount: number }[];
  events?: {
    swap?: {
      nativeInput?: { account: string; amount: string | number };
      nativeOutput?: { account: string; amount: string | number };
      tokenInputs?: { userAccount: string; mint: string; rawTokenAmount: { tokenAmount: string; decimals: number } }[];
      tokenOutputs?: { userAccount: string; mint: string; rawTokenAmount: { tokenAmount: string; decimals: number } }[];
    };
  };
  // Per-account net balance changes for the whole transaction — the same
  // ground-truth deltas Helius computed from the actual pre/post balances,
  // as opposed to events.swap (see extractSwap for why that field can't be
  // trusted).
  accountData?: {
    account: string;
    nativeBalanceChange: number;
    tokenBalanceChanges?: { mint: string; userAccount: string; rawTokenAmount: { tokenAmount: string; decimals: number } }[];
  }[];
}

// ---------- helpers ----------

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function heliusFetch(url: string, retries = 2): Promise<HeliusTx[]> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(9000) });
      if (r.status === 429) {
        await sleep(600 * (attempt + 1));
        continue;
      }
      if (!r.ok) return [];
      const data = await r.json();
      return Array.isArray(data) ? data : [];
    } catch {
      if (attempt < retries) await sleep(400);
    }
  }
  return [];
}

// Walk backwards through an address's transaction history page by page (via the
// `before` signature cursor) until we reach `cutoffTs`, run out of pages, hit
// `maxPages`, or blow through the shared time budget.
//
// NOTE: for very busy programs (Jupiter, Raydium, PumpSwap) a single page of
// 100 "SWAP" transactions can cover as little as a few seconds of real time —
// Helius doesn't always fill a page to the requested `limit` even when much
// more history exists, so treating a short page as "end of history" was wrong
// and made this stop after page 1 almost every time. We only stop early on a
// genuinely empty page now. In practice this means fully covering hours of
// activity on hot programs via pagination alone is still not realistic (would
// take thousands of pages) — see scripts/discovery-server.ts's webhook-fed
// log for how we actually get multi-hour coverage on those.
export async function fetchSwapsWindow(
  address: string,
  apiKey: string,
  cutoffTs: number,
  maxPages: number,
  deadlineMs: number,
  onRequest: () => void
): Promise<HeliusTx[]> {
  const all: HeliusTx[] = [];
  let before: string | undefined;

  for (let page = 0; page < maxPages; page++) {
    if (Date.now() > deadlineMs) break;

    const url = `${HELIUS}/addresses/${address}/transactions?api-key=${apiKey}&type=SWAP&limit=100`
      + (before ? `&before=${before}` : "");
    onRequest();
    const batch = await heliusFetch(url);
    if (!batch.length) break;

    all.push(...batch);
    const oldest = batch[batch.length - 1];
    if (oldest.timestamp < cutoffTs) break;
    before = oldest.signature;
    await sleep(150);
  }

  return all;
}

async function pool<T, R>(items: T[], concurrency: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  let idx = 0;
  async function worker() {
    while (idx < items.length) {
      const i = idx++;
      results[i] = await fn(items[i]);
      await sleep(150);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

// Fallback only, used if the live fetch fails entirely — deliberately not
// treated as "close enough" anywhere else, since SOL's price moves too much
// for a hardcoded number to stay accurate for long.
const SOL_PRICE_FALLBACK = 80;

export async function getSolPrice(): Promise<number> {
  try {
    const r = await fetch(`${DEX}/latest/dex/tokens/${WSOL}`);
    if (!r.ok) return SOL_PRICE_FALLBACK;
    const d = await r.json();
    const pairs = (d.pairs || []) as { quoteToken?: { symbol?: string }; priceUsd?: string; liquidity?: { usd?: number } }[];

    // WSOL's /tokens/ endpoint returns EVERY pair involving the address as
    // either side, across every DEX — pairs[0] is not necessarily SOL/USDC
    // (bug: it previously picked whatever came first, occasionally an
    // unrelated low-liquidity pair, silently corrupting every dollar figure
    // downstream by whatever factor that pair's price was off by). Restrict
    // to genuine SOL/stablecoin pairs and take the most liquid one.
    const solStablePairs = pairs.filter((p) =>
      (p.quoteToken?.symbol === "USDC" || p.quoteToken?.symbol === "USDT") && (p.liquidity?.usd || 0) > 10_000
    );
    const best = solStablePairs.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];
    const p = parseFloat(best?.priceUsd || "0");
    return p > 1 ? p : SOL_PRICE_FALLBACK;
  } catch { return SOL_PRICE_FALLBACK; }
}

const symbolCache = new Map<string, string>();

export async function resolveSymbols(mints: string[]): Promise<Map<string, string>> {
  const unknown = mints.filter((m) => !symbolCache.has(m));
  for (let i = 0; i < unknown.length; i += 30) {
    try {
      const chunk = unknown.slice(i, i + 30).join(",");
      const r = await fetch(`${DEX}/latest/dex/tokens/${chunk}`);
      if (!r.ok) continue;
      const d = await r.json();
      for (const p of (d.pairs || []) as { baseToken: { address: string; symbol: string } }[]) {
        if (p.baseToken?.address && p.baseToken?.symbol) {
          symbolCache.set(p.baseToken.address, p.baseToken.symbol);
        }
      }
    } catch { /* ignore */ }
  }
  const out = new Map<string, string>();
  for (const m of mints) {
    out.set(m, symbolCache.get(m) || m.slice(0, 4) + "..." + m.slice(-4));
  }
  return out;
}

// ---------- swap extraction & wallet analysis ----------

interface RawPosition {
  buys: { usd: number; ts: number; tokens: number }[];
  sells: { usd: number; ts: number; tokens: number }[];
}

export interface ExtractedSwap {
  mint: string;
  usd: number;
  side: "buy" | "sell";
  // Amount of the (non-stable) traded token itself — lets the analyzer match
  // sells against buys by quantity instead of assuming "any sell closes the
  // whole position", which misread partial exits as full ones.
  tokens: number;
}

// Reads the swap directly from the wallet's own balance deltas (accountData),
// instead of trusting Helius's synthesized events.swap summary.
//
// events.swap looked authoritative but isn't: for Jupiter-routed multi-hop
// swaps it can report a wildly wrong amount for the "main" leg — caught via a
// real trade where events.swap.nativeInput said "0.005 SOL" but the wallet's
// actual accountData.nativeBalanceChange for that same transaction was
// -5.000016078 SOL (a ~1000x discrepancy, most likely Helius's synthesis
// locking onto an inner sub-instruction of the route instead of the wallet's
// real net spend). accountData is Helius's other, lower-level field — the
// actual computed pre/post balance difference per account, the same kind of
// ground truth extractSwapFromRaw already reads directly from raw
// preBalances/postBalances for the free (non-Helius) feed. Trusting that
// instead makes this function's numbers reconcilable with a block explorer.
export function extractSwap(tx: HeliusTx, solPrice: number, wallet: string): ExtractedSwap | null {
  const accountData = tx.accountData;
  if (!accountData) return null;

  const nativeDelta = (accountData.find((a) => a.account === wallet)?.nativeBalanceChange || 0) / 1e9;

  // Token balance changes live on the wallet's associated token accounts
  // (different pubkeys from the wallet itself), scattered across accountData
  // — collect every leg owned by this wallet, keyed by mint. rawTokenAmount
  // is already a signed delta, so no separate pre/post subtraction needed.
  const tokenDeltas = new Map<string, number>();
  for (const a of accountData) {
    for (const t of a.tokenBalanceChanges || []) {
      if (t.userAccount !== wallet) continue;
      const amt = Number(t.rawTokenAmount.tokenAmount) / 10 ** t.rawTokenAmount.decimals;
      tokenDeltas.set(t.mint, (tokenDeltas.get(t.mint) || 0) + amt);
    }
  }

  // Some wallets trade from a wrapped-SOL token account instead of native
  // SOL — fold it into the SOL-side delta so those trades aren't dropped.
  const solDelta = nativeDelta + (tokenDeltas.get(WSOL) || 0);
  const stableDelta = (tokenDeltas.get(USDC) || 0) + (tokenDeltas.get(USDT) || 0);

  let bestMint: string | null = null;
  let bestDelta = 0;
  for (const [mint, delta] of tokenDeltas) {
    if (STABLES.has(mint)) continue;
    if (Math.abs(delta) > Math.abs(bestDelta)) { bestDelta = delta; bestMint = mint; }
  }
  if (!bestMint || bestDelta === 0) return null;

  // SOL down + token up = buy; SOL up + token down = sell. Only count it as
  // a buy/sell of THIS mint if the token actually moved the matching direction
  // (guards against unrelated token dust sitting in the same transaction).
  if (Math.abs(solDelta) >= 0.0005) {
    const side: "buy" | "sell" = solDelta < 0 ? "buy" : "sell";
    if ((side === "buy" && bestDelta > 0) || (side === "sell" && bestDelta < 0)) {
      return { mint: bestMint, usd: Math.abs(solDelta) * solPrice, side, tokens: Math.abs(bestDelta) };
    }
  }

  // No SOL-side movement — many trades (especially larger ones) route
  // through USDC/USDT instead of SOL entirely. Missing these was a real bug:
  // it silently dropped a chunk of a wallet's real buy volume, making its
  // PnL% look far larger than it actually was (small counted cost, full
  // proceeds) and could even flip an actual loss into an apparent win.
  if (Math.abs(stableDelta) >= 0.5) {
    const side: "buy" | "sell" = stableDelta < 0 ? "buy" : "sell";
    if ((side === "buy" && bestDelta > 0) || (side === "sell" && bestDelta < 0)) {
      return { mint: bestMint, usd: Math.abs(stableDelta), side, tokens: Math.abs(bestDelta) };
    }
  }

  return null;
}

// ---------- raw webhook parsing (no Helius "enhanced" parsing = far fewer credits) ----------

export interface RawHeliusTx {
  blockTime: number;
  meta: {
    err: unknown | null;
    fee: number;
    preBalances: number[];
    postBalances: number[];
    preTokenBalances?: { accountIndex: number; mint: string; owner?: string; uiTokenAmount: { uiAmount: number | null } }[];
    postTokenBalances?: { accountIndex: number; mint: string; owner?: string; uiTokenAmount: { uiAmount: number | null } }[];
  };
  transaction: {
    message: { accountKeys: string[] };
    signatures: string[];
  };
}

// Derives a swap directly from the transaction's own before/after balances —
// no per-DEX instruction decoding needed, and no "enhanced" parsing from
// Helius (which is what actually costs credits per webhook delivery). Safe
// from the earlier false-positive bug (airdrops/ATA-rent looking like tiny
// buys) because Helius's webhook `transactionTypes: ["SWAP"]` filter has
// already confirmed, at the classification level, that this transaction is a
// genuine swap on one of our watched DEX programs — we're only computing the
// USD amount here, not deciding whether it's a swap in the first place.
export function extractSwapFromRaw(
  tx: RawHeliusTx,
  solPrice: number
): { mint: string; usd: number; side: "buy" | "sell"; wallet: string; ts: number } | null {
  if (tx.meta?.err) return null; // failed transaction, nothing actually happened

  const wallet = tx.transaction?.message?.accountKeys?.[0]; // fee payer is always index 0
  if (!wallet || wallet.length < 32) return null;

  const pre = tx.meta.preBalances?.[0];
  const post = tx.meta.postBalances?.[0];
  if (pre === undefined || post === undefined) return null;

  // Fee payer always pays the network fee out of their own balance — add it
  // back so we isolate the SOL that actually moved as part of the swap itself.
  const nativeDelta = (post - pre + (tx.meta.fee || 0)) / 1e9;

  // Build per-mint balance deltas for the wallet's own token accounts, split
  // into "real" (non-stable) tokens and stablecoins — we need both: the real
  // token to identify what was traded, the stablecoin as an alternative
  // pricing currency for trades that didn't route through SOL at all.
  const preTok = new Map<string, number>();
  for (const t of tx.meta.preTokenBalances || []) {
    if (t.owner !== wallet) continue;
    preTok.set(t.mint, t.uiTokenAmount.uiAmount ?? 0);
  }
  const postTok = new Map<string, number>();
  for (const t of tx.meta.postTokenBalances || []) {
    if (t.owner !== wallet) continue;
    postTok.set(t.mint, t.uiTokenAmount.uiAmount ?? 0);
  }

  let bestMint: string | null = null;
  let bestDelta = 0;
  for (const mint of new Set([...preTok.keys(), ...postTok.keys()])) {
    if (STABLES.has(mint)) continue;
    const delta = (postTok.get(mint) ?? 0) - (preTok.get(mint) ?? 0);
    if (Math.abs(delta) > Math.abs(bestDelta)) { bestDelta = delta; bestMint = mint; }
  }

  // Some wallets trade from a wrapped-SOL token account instead of native SOL
  // (native balance barely moves, the wSOL ATA does) — same money, different
  // plumbing. Fold the wSOL delta into the SOL leg so those aren't dropped.
  const wsolDelta = (postTok.get(WSOL) ?? 0) - (preTok.get(WSOL) ?? 0);
  const solDelta = nativeDelta + wsolDelta;

  if (bestMint && bestDelta !== 0 && Math.abs(solDelta) >= 0.0005) {
    // SOL down + token up = buy; SOL up + token down = sell.
    const side: "buy" | "sell" = solDelta < 0 ? "buy" : "sell";
    if ((side === "buy" && bestDelta > 0) || (side === "sell" && bestDelta < 0)) {
      return { mint: bestMint, usd: Math.abs(solDelta) * solPrice, side, wallet, ts: tx.blockTime };
    }
  }

  // No clean SOL leg — many trades (especially larger ones) route through
  // USDC/USDT instead. Missing these silently undercounted a wallet's real
  // buy volume, inflating its apparent PnL% (small counted cost, full
  // proceeds) and could even flip an actual loss into an apparent win.
  if (bestMint && bestDelta !== 0) {
    const usdcDelta = (postTok.get(USDC) ?? 0) - (preTok.get(USDC) ?? 0);
    const usdtDelta = (postTok.get(USDT) ?? 0) - (preTok.get(USDT) ?? 0);
    const stableDelta = Math.abs(usdcDelta) >= Math.abs(usdtDelta) ? usdcDelta : usdtDelta;
    if (Math.abs(stableDelta) >= 0.5) {
      const side: "buy" | "sell" = stableDelta < 0 ? "buy" : "sell";
      if ((side === "buy" && bestDelta > 0) || (side === "sell" && bestDelta < 0)) {
        return { mint: bestMint, usd: Math.abs(stableDelta), side, wallet, ts: tx.blockTime };
      }
    }
  }

  return null;
}

export function analyzeWallet(txns: HeliusTx[], solPrice: number, wallet: string) {
  const positions = new Map<string, RawPosition>();

  for (const tx of txns) {
    const swap = extractSwap(tx, solPrice, wallet);
    if (!swap || swap.usd < 1) continue;
    if (!positions.has(swap.mint)) positions.set(swap.mint, { buys: [], sells: [] });
    const pos = positions.get(swap.mint)!;
    if (swap.side === "buy") pos.buys.push({ usd: swap.usd, ts: tx.timestamp, tokens: swap.tokens });
    else pos.sells.push({ usd: swap.usd, ts: tx.timestamp, tokens: swap.tokens });
  }

  let wins = 0, losses = 0, realizedPnl = 0, totalBuyUsd = 0, totalSellUsd = 0, buyCount = 0;
  const holdTimes: number[] = [];
  const positionInfos: (Omit<TokenPositionInfo, "symbol"> & { firstBuyTs: number })[] = [];

  for (const [mint, pos] of positions.entries()) {
    // Sells with NO buys in the visible window have an unknown cost basis
    // (the buy happened before our history cutoff) — counting their proceeds
    // as near-pure profit produced absurd figures like "+21,968%". Skip them
    // entirely, including from the volume totals, so all reported numbers
    // reconcile with the position list.
    if (!pos.buys.length) continue;

    const buyUsd = pos.buys.reduce((s, t) => s + t.usd, 0);
    const sellUsd = pos.sells.reduce((s, t) => s + t.usd, 0);
    const boughtTok = pos.buys.reduce((s, t) => s + t.tokens, 0);

    const allTs = [...pos.buys, ...pos.sells].map((t) => t.ts);
    const lastTs = Math.max(...allTs);
    const firstBuyTs = Math.min(...pos.buys.map((t) => t.ts));

    if (pos.sells.length) {
      // Walk the position CHRONOLOGICALLY with a running inventory
      // (average-cost basis). A sell can only realize PnL against tokens
      // already bought by that moment — matching by quantity alone paired
      // sells with buys that happened AFTER them (real case: wallet sold
      // pre-window tokens on the 8th, bought $7 worth on the 10th, and the
      // old math credited the $7 buy with the whole $2.8K of sales →
      // "+21,203%"). Sell portions with no covering inventory have an
      // unknown cost basis and are ignored entirely.
      const events = [
        ...pos.buys.map((t) => ({ ...t, side: "buy" as const })),
        ...pos.sells.map((t) => ({ ...t, side: "sell" as const })),
      ].sort((a, b) => a.ts - b.ts);

      const usableTokens = events.every((e) => e.tokens > 0);
      let pnl = 0;
      let matchedCost = 0;
      let matchedProceeds = 0;
      let fullyClosed: boolean;

      if (usableTokens) {
        let invTok = 0;
        let invCost = 0;
        for (const e of events) {
          if (e.side === "buy") {
            invTok += e.tokens;
            invCost += e.usd;
          } else if (invTok > 0) {
            const m = Math.min(e.tokens, invTok);
            const proceeds = e.usd * (m / e.tokens);
            const cost = invCost * (m / invTok);
            matchedProceeds += proceeds;
            matchedCost += cost;
            invTok -= m;
            invCost -= cost;
          }
          // sell with zero inventory: skipped — nothing it can close
        }
        pnl = matchedProceeds - matchedCost;
        fullyClosed = invTok <= boughtTok * 0.05;
      } else {
        // Token amounts unavailable — fall back to plain USD totals.
        matchedCost = buyUsd;
        matchedProceeds = sellUsd;
        pnl = sellUsd - buyUsd;
        fullyClosed = true;
      }

      // Nothing matched at all (every sell predates every buy) — same as a
      // sell-only position: no basis, no verdict.
      if (matchedCost <= 0) continue;

      // Volume totals count only what participates in the analysis: all buys,
      // but just the MATCHED sell proceeds — gross sells include liquidations
      // of pre-window holdings, which would make the totals irreconcilable
      // with the position list (and inflate "Продано всего").
      totalBuyUsd += buyUsd;
      totalSellUsd += matchedProceeds;
      buyCount += pos.buys.length;

      realizedPnl += pnl;
      if (fullyClosed) {
        if (pnl > 0) wins++; else losses++;
      }

      const lastSell = Math.max(...pos.sells.map((t) => t.ts));
      const holdMin = lastSell > firstBuyTs ? (lastSell - firstBuyTs) / 60 : 0;
      if (holdMin > 0 && fullyClosed) holdTimes.push(holdMin);

      positionInfos.push({
        mint,
        buyUsd: Math.round(buyUsd),
        sellUsd: Math.round(matchedProceeds),
        pnlUsd: Math.round(pnl),
        pnlPct: Math.round((pnl / matchedCost) * 1000) / 10,
        buyCount: pos.buys.length,
        sellCount: pos.sells.length,
        holdMinutes: Math.round(holdMin),
        lastTs,
        firstBuyTs,
        status: fullyClosed ? "closed" : "open",
      });
    } else {
      totalBuyUsd += buyUsd;
      buyCount += pos.buys.length;
      positionInfos.push({
        mint,
        buyUsd: Math.round(buyUsd),
        sellUsd: 0,
        pnlUsd: 0,
        pnlPct: 0,
        buyCount: pos.buys.length,
        sellCount: 0,
        holdMinutes: 0,
        lastTs,
        firstBuyTs,
        status: "open",
      });
    }
  }

  const allTs = txns.map((t) => t.timestamp);

  return {
    wins,
    losses,
    totalPnlUsd: realizedPnl,
    totalBuyVolumeUsd: totalBuyUsd,
    totalSellVolumeUsd: totalSellUsd,
    avgBuyUsd: buyCount ? totalBuyUsd / buyCount : 0,
    avgHoldMinutes: holdTimes.length ? holdTimes.reduce((a, b) => a + b, 0) / holdTimes.length : 0,
    lastActivity: allTs.length ? Math.max(...allTs) : 0,
    firstActivity: allTs.length ? Math.min(...allTs) : 0,
    openPositions: positionInfos.filter((p) => p.status === "open").length,
    positionInfos,
  };
}

function calcScore(w: { winRate: number; totalPnlUsd: number; totalTrades: number; lastActivity: number }): number {
  const winScore = w.winRate * 0.4;
  const pnlScore = w.totalPnlUsd > 0 ? Math.min(Math.log10(w.totalPnlUsd + 1) * 7, 35) : 0;
  const tradesScore = Math.min(w.totalTrades * 0.5, 15);
  const recencyScore = (Date.now() / 1000 - w.lastActivity) < 3600 ? 10 : 0;
  return Math.round(winScore + pnlScore + tradesScore + recencyScore);
}

function calcTags(w: SmartWallet): string[] {
  const tags: string[] = [];
  if (w.winRate >= 80) tags.push("🔥 Top Trader");
  else if (w.winRate >= 65) tags.push("🎯 Smart Money");
  if (w.totalPnlUsd > 50_000) tags.push("💎 Whale");
  else if (w.totalPnlUsd > 5_000) tags.push("💰 Profitable");
  if (w.avgHoldMinutes > 0 && w.avgHoldMinutes < 30) tags.push("⚡ Sniper");
  else if (w.avgHoldMinutes >= 30 && w.avgHoldMinutes < 120) tags.push("🏃 Flipper");
  if (w.totalTrades > 20) tags.push("🔄 Active");
  if (!tags.length) tags.push("📊 Trader");
  return tags;
}

export function makeFilterFn(filters: ScanFilters) {
  const cutoff = Date.now() / 1000 - filters.maxInactiveHours * 3600;
  return (w: SmartWallet) =>
    w.totalPnlUsd >= filters.minPnlUsd &&
    w.winRate >= filters.minWinRate &&
    w.totalTrades >= filters.minTrades &&
    w.lastActivity >= cutoff;
}

export interface ScanInfo {
  scannedSwaps: number;
  scannedWallets: number;
  rejected: number;
  heliusRequests: number;
  durationSec: number;
}

export interface WalletCacheEntry { data: SmartWallet; ts: number }

// Analyzes a pre-vetted list of candidate wallet addresses (their OWN trade
// history is always complete regardless of volume, since it's scoped to one
// wallet — unlike the global swap feed, which for busy DEX programs like
// Jupiter moves too fast to paginate back more than a few seconds via
// on-demand history pulls). Candidate discovery itself now happens via a
// continuously-collected webhook log (see scripts/discovery-server.ts),
// which is the only way to genuinely cover hours of activity on those programs.
export async function runFullScan(
  apiKey: string,
  candidates: string[],
  walletCache: Map<string, WalletCacheEntry>,
  walletTtlMs = 90 * 60 * 1000
): Promise<{ allAnalyzed: SmartWallet[]; scanInfo: ScanInfo }> {
  const scanStart = Date.now();
  let heliusRequests = 0;

  const solPrice = await getSolPrice();

  if (!candidates.length) {
    return {
      allAnalyzed: [],
      scanInfo: { scannedSwaps: 0, scannedWallets: 0, rejected: 0, heliusRequests, durationSec: Math.round((Date.now() - scanStart) / 1000) },
    };
  }

  const results: SmartWallet[] = [];
  const toFetch: string[] = [];

  for (const addr of candidates) {
    const cached = walletCache.get(addr);
    if (cached && Date.now() - cached.ts < walletTtlMs) {
      results.push(cached.data);
    } else {
      toFetch.push(addr);
    }
  }

  const walletTxLists = await pool(toFetch, 4, (addr) => {
    heliusRequests++;
    return heliusFetch(`${HELIUS}/addresses/${addr}/transactions?api-key=${apiKey}&type=SWAP&limit=100`);
  });

  const pendingWallets: { addr: string; stats: ReturnType<typeof analyzeWallet> }[] = [];
  let rejectedCount = 0;

  toFetch.forEach((addr, i) => {
    const txns = walletTxLists[i] || [];
    if (txns.length < 2) { rejectedCount++; return; }

    const stats = analyzeWallet(txns, solPrice, addr);
    const totalTrades = stats.wins + stats.losses;
    if (totalTrades < 1) { rejectedCount++; return; }

    pendingWallets.push({ addr, stats });
  });

  const allMints = new Set<string>();
  for (const pw of pendingWallets) {
    for (const p of pw.stats.positionInfos) allMints.add(p.mint);
  }
  const symbols = await resolveSymbols(Array.from(allMints).slice(0, 90));

  const DAY_AGO = Date.now() / 1000 - 24 * 3600;

  for (const { addr, stats } of pendingWallets) {
    const totalTrades = stats.wins + stats.losses;
    const winRate = Math.round((stats.wins / totalTrades) * 100);

    const positions: TokenPositionInfo[] = stats.positionInfos
      .map((p) => ({ ...p, symbol: symbols.get(p.mint) || p.mint.slice(0, 6) }))
      .sort((a, b) => {
        if (a.status !== b.status) return a.status === "open" ? -1 : 1;
        if (a.status === "open") return b.lastTs - a.lastTs;
        return Math.abs(b.pnlUsd) - Math.abs(a.pnlUsd);
      })
      .slice(0, 12);

    const closed = positions.filter((p) => p.status === "closed");
    const best = closed.length ? closed.reduce((a, b) => (b.pnlUsd > a.pnlUsd ? b : a)) : null;
    const worst = closed.length ? closed.reduce((a, b) => (b.pnlUsd < a.pnlUsd ? b : a)) : null;

    const recentBuys: RecentBuy[] = stats.positionInfos
      .filter((p) => p.firstBuyTs >= DAY_AGO && p.buyCount > 0)
      .sort((a, b) => b.firstBuyTs - a.firstBuyTs)
      .slice(0, 5)
      .map((p) => ({
        tokenSymbol: symbols.get(p.mint) || p.mint.slice(0, 6),
        tokenAddress: p.mint,
        pairAddress: "",
        buyAmountUsd: p.buyUsd,
        buyTime: p.firstBuyTs,
        priceChangeAfter: p.status === "closed" ? p.pnlPct : undefined,
        status: p.status === "open" ? "holding" : p.pnlUsd > 0 ? "sold_profit" : "sold_loss",
      }));

    const partial = {
      address: addr,
      winRate,
      totalPnlUsd: Math.round(stats.totalPnlUsd),
      totalTrades,
      wins: stats.wins,
      losses: stats.losses,
      avgBuyUsd: Math.round(stats.avgBuyUsd),
      avgHoldMinutes: Math.round(stats.avgHoldMinutes),
      lastActivity: stats.lastActivity,
      firstActivity: stats.firstActivity,
      totalBuyVolumeUsd: Math.round(stats.totalBuyVolumeUsd),
      totalSellVolumeUsd: Math.round(stats.totalSellVolumeUsd),
      openPositions: stats.openPositions,
      bestTrade: best ? { symbol: best.symbol, pnlUsd: best.pnlUsd, pnlPct: best.pnlPct } : null,
      worstTrade: worst ? { symbol: worst.symbol, pnlUsd: worst.pnlUsd, pnlPct: worst.pnlPct } : null,
      recentBuys,
      positions,
    };

    const score = calcScore(partial);
    const wallet: SmartWallet = { ...partial, score, tags: [] };
    wallet.tags = calcTags(wallet);

    walletCache.set(addr, { data: wallet, ts: Date.now() });
    results.push(wallet);
  }

  return {
    allAnalyzed: results,
    scanInfo: {
      scannedSwaps: 0,
      scannedWallets: candidates.length,
      rejected: rejectedCount,
      heliusRequests,
      durationSec: Math.round((Date.now() - scanStart) / 1000),
    },
  };
}

export function getDemoWallets(): SmartWallet[] {
  const now = Date.now() / 1000;
  return [
    {
      address: "9nn6KBHBGMGrTHPiwvqgbJUGMfaQdnaqCYCmQpTwjBBZ",
      winRate: 84, totalPnlUsd: 127400, totalTrades: 89, wins: 75, losses: 14,
      avgBuyUsd: 1200, avgHoldMinutes: 18, lastActivity: now - 1200, firstActivity: now - 86400 * 30,
      totalBuyVolumeUsd: 340000, totalSellVolumeUsd: 467400, openPositions: 2,
      bestTrade: { symbol: "WIF", pnlUsd: 24800, pnlPct: 312 },
      worstTrade: { symbol: "MYRO", pnlUsd: -1900, pnlPct: -42 },
      score: 92,
      tags: ["🔥 Top Trader", "💰 Profitable", "⚡ Sniper"],
      recentBuys: [
        { tokenSymbol: "BONK", tokenAddress: "", pairAddress: "", buyAmountUsd: 2400, buyTime: now - 3600, priceChangeAfter: 34.2, status: "sold_profit" },
        { tokenSymbol: "WIF", tokenAddress: "", pairAddress: "", buyAmountUsd: 1800, buyTime: now - 7200, priceChangeAfter: 18.7, status: "sold_profit" },
      ],
      positions: [
        { mint: "", symbol: "POPCAT", buyUsd: 3200, sellUsd: 0, pnlUsd: 0, pnlPct: 0, buyCount: 2, sellCount: 0, holdMinutes: 0, lastTs: now - 1200, status: "open" },
        { mint: "", symbol: "WIF", buyUsd: 7950, sellUsd: 32750, pnlUsd: 24800, pnlPct: 312, buyCount: 3, sellCount: 2, holdMinutes: 340, lastTs: now - 7200, status: "closed" },
        { mint: "", symbol: "BONK", buyUsd: 5100, sellUsd: 12400, pnlUsd: 7300, pnlPct: 143.1, buyCount: 2, sellCount: 1, holdMinutes: 95, lastTs: now - 3600, status: "closed" },
        { mint: "", symbol: "MYRO", buyUsd: 4500, sellUsd: 2600, pnlUsd: -1900, pnlPct: -42.2, buyCount: 1, sellCount: 1, holdMinutes: 22, lastTs: now - 43200, status: "closed" },
      ],
    },
    {
      address: "GThUX1Atko4tqhN2NaiTazWSeFWMuiUvfFnyJyUghFMJ",
      winRate: 78, totalPnlUsd: 84200, totalTrades: 134, wins: 104, losses: 30,
      avgBuyUsd: 650, avgHoldMinutes: 45, lastActivity: now - 2700, firstActivity: now - 86400 * 60,
      totalBuyVolumeUsd: 187000, totalSellVolumeUsd: 271200, openPositions: 1,
      bestTrade: { symbol: "MEW", pnlUsd: 11200, pnlPct: 187 },
      worstTrade: { symbol: "BOME", pnlUsd: -800, pnlPct: -18 },
      score: 85,
      tags: ["🎯 Smart Money", "💰 Profitable", "🏃 Flipper"],
      recentBuys: [
        { tokenSymbol: "MEW", tokenAddress: "", pairAddress: "", buyAmountUsd: 1100, buyTime: now - 1800, priceChangeAfter: 22.5, status: "sold_profit" },
      ],
      positions: [
        { mint: "", symbol: "JUP", buyUsd: 900, sellUsd: 0, pnlUsd: 0, pnlPct: 0, buyCount: 1, sellCount: 0, holdMinutes: 0, lastTs: now - 2700, status: "open" },
        { mint: "", symbol: "MEW", buyUsd: 5990, sellUsd: 17190, pnlUsd: 11200, pnlPct: 187, buyCount: 4, sellCount: 3, holdMinutes: 120, lastTs: now - 1800, status: "closed" },
      ],
    },
  ];
}
