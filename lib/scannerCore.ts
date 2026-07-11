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
// not just whoever happens to be trading on a handful of trending pairs.
export const DEX_SOURCES = [
  { name: "Jupiter", address: "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4" },
  { name: "Raydium AMM", address: "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8" },
  { name: "Raydium CLMM", address: "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK" },
  { name: "PumpSwap", address: "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA" },
  { name: "Pump.fun", address: "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P" },
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

interface HeliusTx {
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
async function fetchSwapsWindow(
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
    if (batch.length < 100) break;
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

export async function getSolPrice(): Promise<number> {
  try {
    const r = await fetch(`${DEX}/latest/dex/tokens/${WSOL}`);
    if (!r.ok) return 170;
    const d = await r.json();
    const p = parseFloat(d.pairs?.[0]?.priceUsd || "0");
    return p > 1 ? p : 170;
  } catch { return 170; }
}

const symbolCache = new Map<string, string>();

async function resolveSymbols(mints: string[]): Promise<Map<string, string>> {
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
  buys: { usd: number; ts: number }[];
  sells: { usd: number; ts: number }[];
}

function extractSwap(tx: HeliusTx, wallet: string, solPrice: number): { mint: string; usd: number; side: "buy" | "sell" } | null {
  const swap = tx.events?.swap;

  if (swap) {
    const nativeIn = swap.nativeInput && Number(swap.nativeInput.amount) / 1e9;
    const nativeOut = swap.nativeOutput && Number(swap.nativeOutput.amount) / 1e9;

    // Only count as a "buy/sell" if the other side is an actual (non-stable) token.
    // SOL<->USDC or USDC<->USDT are currency conversions, not memecoin trades.
    if (nativeIn && nativeIn > 0.0005 && swap.tokenOutputs?.length) {
      const out = swap.tokenOutputs.find((t) => !STABLES.has(t.mint));
      if (out) return { mint: out.mint, usd: nativeIn * solPrice, side: "buy" };
    }
    if (nativeOut && nativeOut > 0.0005 && swap.tokenInputs?.length) {
      const inp = swap.tokenInputs.find((t) => !STABLES.has(t.mint));
      if (inp) return { mint: inp.mint, usd: nativeOut * solPrice, side: "sell" };
    }
    return null;
  }

  const solSent = (tx.nativeTransfers || []).filter((t) => t.fromUserAccount === wallet).reduce((s, t) => s + t.amount, 0) / 1e9;
  const solRecv = (tx.nativeTransfers || []).filter((t) => t.toUserAccount === wallet).reduce((s, t) => s + t.amount, 0) / 1e9;
  const tokRecv = (tx.tokenTransfers || []).find((t) => t.toUserAccount === wallet && !STABLES.has(t.mint));
  const tokSent = (tx.tokenTransfers || []).find((t) => t.fromUserAccount === wallet && !STABLES.has(t.mint));

  if (solSent > 0.002 && tokRecv) return { mint: tokRecv.mint, usd: solSent * solPrice, side: "buy" };
  if (solRecv > 0.002 && tokSent) return { mint: tokSent.mint, usd: solRecv * solPrice, side: "sell" };
  return null;
}

function analyzeWallet(txns: HeliusTx[], wallet: string, solPrice: number) {
  const positions = new Map<string, RawPosition>();

  for (const tx of txns) {
    const swap = extractSwap(tx, wallet, solPrice);
    if (!swap || swap.usd < 1) continue;
    if (!positions.has(swap.mint)) positions.set(swap.mint, { buys: [], sells: [] });
    const pos = positions.get(swap.mint)!;
    if (swap.side === "buy") pos.buys.push({ usd: swap.usd, ts: tx.timestamp });
    else pos.sells.push({ usd: swap.usd, ts: tx.timestamp });
  }

  let wins = 0, losses = 0, realizedPnl = 0, totalBuyUsd = 0, totalSellUsd = 0, buyCount = 0;
  const holdTimes: number[] = [];
  const positionInfos: (Omit<TokenPositionInfo, "symbol"> & { firstBuyTs: number })[] = [];

  for (const [mint, pos] of positions.entries()) {
    if (!pos.buys.length && !pos.sells.length) continue;
    const buyUsd = pos.buys.reduce((s, t) => s + t.usd, 0);
    const sellUsd = pos.sells.reduce((s, t) => s + t.usd, 0);
    totalBuyUsd += buyUsd;
    totalSellUsd += sellUsd;
    buyCount += pos.buys.length;

    const allTs = [...pos.buys, ...pos.sells].map((t) => t.ts);
    const lastTs = Math.max(...allTs);
    const firstBuyTs = pos.buys.length ? Math.min(...pos.buys.map((t) => t.ts)) : lastTs;

    if (pos.buys.length && pos.sells.length) {
      const pnl = sellUsd - buyUsd;
      realizedPnl += pnl;
      if (pnl > 0) wins++; else losses++;

      const lastSell = Math.max(...pos.sells.map((t) => t.ts));
      const holdMin = lastSell > firstBuyTs ? (lastSell - firstBuyTs) / 60 : 0;
      if (holdMin > 0) holdTimes.push(holdMin);

      positionInfos.push({
        mint,
        buyUsd: Math.round(buyUsd),
        sellUsd: Math.round(sellUsd),
        pnlUsd: Math.round(pnl),
        pnlPct: buyUsd > 0 ? Math.round((pnl / buyUsd) * 1000) / 10 : 0,
        buyCount: pos.buys.length,
        sellCount: pos.sells.length,
        holdMinutes: Math.round(holdMin),
        lastTs,
        firstBuyTs,
        status: "closed",
      });
    } else if (pos.buys.length) {
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

// Runs the full pipeline: paginate the global swap feed within `windowHours`,
// derive trader candidates, analyze each one's own trade history, and return
// EVERY wallet with at least one closed trade (unfiltered — callers decide
// what "worthy" means via makeFilterFn on the result).
export async function runFullScan(
  apiKey: string,
  windowHours: number,
  walletCache: Map<string, WalletCacheEntry>,
  walletTtlMs = 20 * 60 * 1000,
  timeBudgetMs = 55_000
): Promise<{ allAnalyzed: SmartWallet[]; scanInfo: ScanInfo }> {
  const scanStart = Date.now();
  let heliusRequests = 0;

  const solPrice = await getSolPrice();
  const windowAgo = Date.now() / 1000 - windowHours * 3600;

  const FEED_DEADLINE = scanStart + Math.min(35_000, timeBudgetMs * 0.6);
  const sourceTxLists = await pool(DEX_SOURCES, 5, (src) =>
    fetchSwapsWindow(src.address, apiKey, windowAgo, 10, FEED_DEADLINE, () => { heliusRequests++; })
  );

  const walletActivity = new Map<string, { count: number; totalUsd: number }>();
  let totalSwaps = 0;

  for (const txList of sourceTxLists) {
    for (const tx of txList || []) {
      totalSwaps++;
      const maker = tx.feePayer;
      if (!maker || maker.length < 32) continue;
      if (tx.timestamp < windowAgo) continue;

      const swap = extractSwap(tx, maker, solPrice);
      if (!swap || swap.usd < 20) continue;

      const cur = walletActivity.get(maker) || { count: 0, totalUsd: 0 };
      cur.count++;
      cur.totalUsd += swap.usd;
      walletActivity.set(maker, cur);
    }
  }

  const candidates = Array.from(walletActivity.entries())
    .filter(([, a]) => a.count <= 50)
    .sort((a, b) => b[1].totalUsd - a[1].totalUsd)
    .slice(0, 60)
    .map(([addr]) => addr);

  if (!candidates.length) {
    return {
      allAnalyzed: [],
      scanInfo: { scannedSwaps: totalSwaps, scannedWallets: 0, rejected: 0, heliusRequests, durationSec: Math.round((Date.now() - scanStart) / 1000) },
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

    const stats = analyzeWallet(txns, addr, solPrice);
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
      scannedSwaps: totalSwaps,
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
