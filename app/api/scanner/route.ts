import { NextRequest, NextResponse } from "next/server";

// Allow up to 60s for scanning (Vercel fluid compute)
export const maxDuration = 60;

const DEX = "https://api.dexscreener.com";
const HELIUS = "https://api.helius.xyz/v0";
const WSOL = "So11111111111111111111111111111111111111112";

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

async function getSolPrice(): Promise<number> {
  try {
    const r = await fetch(`${DEX}/latest/dex/tokens/${WSOL}`, { next: { revalidate: 120 } });
    if (!r.ok) return 170;
    const d = await r.json();
    const p = parseFloat(d.pairs?.[0]?.priceUsd || "0");
    return p > 1 ? p : 170;
  } catch { return 170; }
}

// Resolve token mints → symbols via DEX Screener (cached at module level)
const symbolCache = new Map<string, string>();

async function resolveSymbols(mints: string[]): Promise<Map<string, string>> {
  const unknown = mints.filter((m) => !symbolCache.has(m));
  for (let i = 0; i < unknown.length; i += 30) {
    try {
      const chunk = unknown.slice(i, i + 30).join(",");
      const r = await fetch(`${DEX}/latest/dex/tokens/${chunk}`, { next: { revalidate: 300 } });
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

interface TrendingPair {
  pairAddress: string;
  tokenSymbol: string;
  tokenAddress: string;
  priceChange1h: number;
  volumeH1: number;
}

async function getActivePairs(): Promise<TrendingPair[]> {
  const mints = new Set<string>();
  try {
    const [profilesR, boostsR] = await Promise.all([
      fetch(`${DEX}/token-profiles/latest/v1`, { next: { revalidate: 60 } }),
      fetch(`${DEX}/token-boosts/top/v1`, { next: { revalidate: 60 } }),
    ]);
    if (profilesR.ok) {
      const profiles = await profilesR.json() as { tokenAddress: string; chainId: string }[];
      profiles.filter((p) => p.chainId === "solana").slice(0, 25).forEach((p) => mints.add(p.tokenAddress));
    }
    if (boostsR.ok) {
      const boosts = await boostsR.json() as { tokenAddress: string; chainId: string }[];
      boosts.filter((p) => p.chainId === "solana").slice(0, 25).forEach((p) => mints.add(p.tokenAddress));
    }
  } catch { /* ignore */ }

  if (!mints.size) return [];

  const mintList = Array.from(mints);
  const pairs: TrendingPair[] = [];

  for (let i = 0; i < mintList.length; i += 30) {
    try {
      const chunk = mintList.slice(i, i + 30).join(",");
      const r = await fetch(`${DEX}/latest/dex/tokens/${chunk}`, { next: { revalidate: 60 } });
      if (!r.ok) continue;
      const d = await r.json();
      for (const p of (d.pairs || []) as {
        chainId: string; pairAddress: string;
        baseToken: { symbol: string; address: string };
        volume?: { h1?: number }; priceChange?: { h1?: number };
        liquidity?: { usd?: number };
      }[]) {
        if (p.chainId !== "solana") continue;
        if ((p.liquidity?.usd || 0) < 3000) continue;
        if ((p.volume?.h1 || 0) < 500) continue;
        pairs.push({
          pairAddress: p.pairAddress,
          tokenSymbol: p.baseToken.symbol,
          tokenAddress: p.baseToken.address,
          priceChange1h: p.priceChange?.h1 || 0,
          volumeH1: p.volume?.h1 || 0,
        });
        if (p.baseToken?.address && p.baseToken?.symbol) {
          symbolCache.set(p.baseToken.address, p.baseToken.symbol);
        }
      }
    } catch { /* ignore */ }
  }

  const seen = new Set<string>();
  return pairs
    .filter((p) => !seen.has(p.pairAddress) && seen.add(p.pairAddress))
    .sort((a, b) => b.volumeH1 - a.volumeH1)
    .slice(0, 8);
}

// ---------- wallet analysis ----------

interface RawPosition {
  buys: { usd: number; ts: number }[];
  sells: { usd: number; ts: number }[];
}

function extractSwap(tx: HeliusTx, wallet: string, solPrice: number): { mint: string; usd: number; side: "buy" | "sell" } | null {
  const swap = tx.events?.swap;

  if (swap) {
    const nativeIn = swap.nativeInput && Number(swap.nativeInput.amount) / 1e9;
    const nativeOut = swap.nativeOutput && Number(swap.nativeOutput.amount) / 1e9;

    if (nativeIn && nativeIn > 0.0005 && swap.tokenOutputs?.length) {
      const out = swap.tokenOutputs.find((t) => t.mint !== WSOL) || swap.tokenOutputs[0];
      return { mint: out.mint, usd: nativeIn * solPrice, side: "buy" };
    }
    if (nativeOut && nativeOut > 0.0005 && swap.tokenInputs?.length) {
      const inp = swap.tokenInputs.find((t) => t.mint !== WSOL) || swap.tokenInputs[0];
      return { mint: inp.mint, usd: nativeOut * solPrice, side: "sell" };
    }
  }

  const solSent = (tx.nativeTransfers || []).filter((t) => t.fromUserAccount === wallet).reduce((s, t) => s + t.amount, 0) / 1e9;
  const solRecv = (tx.nativeTransfers || []).filter((t) => t.toUserAccount === wallet).reduce((s, t) => s + t.amount, 0) / 1e9;
  const tokRecv = (tx.tokenTransfers || []).find((t) => t.toUserAccount === wallet && t.mint !== WSOL);
  const tokSent = (tx.tokenTransfers || []).find((t) => t.fromUserAccount === wallet && t.mint !== WSOL);

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
  const positionInfos: Omit<TokenPositionInfo, "symbol">[] = [];

  for (const [mint, pos] of positions.entries()) {
    if (!pos.buys.length && !pos.sells.length) continue;
    const buyUsd = pos.buys.reduce((s, t) => s + t.usd, 0);
    const sellUsd = pos.sells.reduce((s, t) => s + t.usd, 0);
    totalBuyUsd += buyUsd;
    totalSellUsd += sellUsd;
    buyCount += pos.buys.length;

    const allTs = [...pos.buys, ...pos.sells].map((t) => t.ts);
    const lastTs = Math.max(...allTs);

    if (pos.buys.length && pos.sells.length) {
      const pnl = sellUsd - buyUsd;
      realizedPnl += pnl;
      if (pnl > 0) wins++; else losses++;

      const firstBuy = Math.min(...pos.buys.map((t) => t.ts));
      const lastSell = Math.max(...pos.sells.map((t) => t.ts));
      const holdMin = lastSell > firstBuy ? (lastSell - firstBuy) / 60 : 0;
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

// ---------- caching ----------

const walletCache = new Map<string, { data: SmartWallet; ts: number }>();
let lastGoodScan: { wallets: SmartWallet[]; ts: number; scannedPairs: number; scannedWallets: number } | null = null;
const WALLET_TTL = 20 * 60 * 1000;
const SCAN_TTL = 3 * 60 * 1000;

// ---------- main handler ----------

export async function GET(req: NextRequest) {
  const apiKey = process.env.HELIUS_API_KEY;
  const mode = req.nextUrl.searchParams.get("mode");
  const forceRefresh = req.nextUrl.searchParams.get("refresh") === "1";

  if (!apiKey) {
    return NextResponse.json({
      wallets: getDemoWallets(),
      real: false,
      hasApiKey: false,
      message: "Добавь Helius API ключ в Settings для реального сканирования",
    });
  }

  // Cached mode: return last scan results WITHOUT touching Helius (0 credits)
  if (mode === "cached") {
    if (lastGoodScan) {
      return NextResponse.json({
        wallets: lastGoodScan.wallets,
        real: true,
        hasApiKey: true,
        cached: true,
        scannedPairs: lastGoodScan.scannedPairs,
        scannedWallets: lastGoodScan.scannedWallets,
        lastScanTs: lastGoodScan.ts,
      });
    }
    return NextResponse.json({
      wallets: [],
      real: true,
      hasApiKey: true,
      cached: true,
      message: "Нажми «Сканировать» чтобы найти прибыльные кошельки",
    });
  }

  if (!forceRefresh && lastGoodScan && Date.now() - lastGoodScan.ts < SCAN_TTL) {
    return NextResponse.json({
      wallets: lastGoodScan.wallets,
      real: true,
      hasApiKey: true,
      cached: true,
      scannedPairs: lastGoodScan.scannedPairs,
      scannedWallets: lastGoodScan.scannedWallets,
    });
  }

  const scanStart = Date.now();
  let heliusRequests = 0;

  try {
    const [solPrice, pairs] = await Promise.all([getSolPrice(), getActivePairs()]);

    if (!pairs.length) {
      return respondWithFallback("Нет активных пар для сканирования");
    }

    const pairTxLists = await pool(pairs, 3, (p) => {
      heliusRequests++;
      return heliusFetch(`${HELIUS}/addresses/${p.pairAddress}/transactions?api-key=${apiKey}&type=SWAP&limit=100`);
    });

    const walletBuys = new Map<string, RecentBuy[]>();

    pairs.forEach((pair, i) => {
      for (const tx of pairTxLists[i] || []) {
        const maker = tx.feePayer;
        if (!maker || maker.length < 32) continue;

        const swap = extractSwap(tx, maker, solPrice);
        if (!swap || swap.side !== "buy" || swap.usd < 20) continue;

        const list = walletBuys.get(maker) || [];
        if (list.length < 5) {
          list.push({
            tokenSymbol: pair.tokenSymbol,
            tokenAddress: pair.tokenAddress,
            pairAddress: pair.pairAddress,
            buyAmountUsd: Math.round(swap.usd),
            buyTime: tx.timestamp,
            priceChangeAfter: pair.priceChange1h || undefined,
            status: pair.priceChange1h > 5 ? "sold_profit" : pair.priceChange1h < -5 ? "sold_loss" : "holding",
          });
        }
        walletBuys.set(maker, list);
      }
    });

    const candidates = Array.from(walletBuys.entries())
      .sort((a, b) => {
        const aScore = a[1].length * 1000 + Math.max(...a[1].map((x) => x.buyAmountUsd));
        const bScore = b[1].length * 1000 + Math.max(...b[1].map((x) => x.buyAmountUsd));
        return bScore - aScore;
      })
      .slice(0, 25)
      .map(([addr]) => addr);

    const results: SmartWallet[] = [];
    const toFetch: string[] = [];

    for (const addr of candidates) {
      const cached = walletCache.get(addr);
      if (cached && Date.now() - cached.ts < WALLET_TTL) {
        cached.data.recentBuys = walletBuys.get(addr) || cached.data.recentBuys;
        results.push(cached.data);
      } else {
        toFetch.push(addr);
      }
    }

    const walletTxLists = await pool(toFetch, 3, (addr) => {
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

      const winRate = Math.round((stats.wins / totalTrades) * 100);
      // Strict filter: only profitable wallets with decent win rate
      if (stats.totalPnlUsd <= 0 || winRate < 60) { rejectedCount++; return; }

      pendingWallets.push({ addr, stats });
    });

    // Resolve symbols for all position mints in one batch
    const allMints = new Set<string>();
    for (const pw of pendingWallets) {
      for (const p of pw.stats.positionInfos) allMints.add(p.mint);
    }
    const symbols = await resolveSymbols(Array.from(allMints).slice(0, 90));

    for (const { addr, stats } of pendingWallets) {
      const totalTrades = stats.wins + stats.losses;
      const winRate = Math.round((stats.wins / totalTrades) * 100);

      // Build enriched positions, sorted: open first (by recency), then closed by |pnl|
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
        recentBuys: walletBuys.get(addr) || [],
        positions,
      };

      const score = calcScore(partial);
      const wallet: SmartWallet = { ...partial, score, tags: [] };
      wallet.tags = calcTags(wallet);

      walletCache.set(addr, { data: wallet, ts: Date.now() });
      results.push(wallet);
    }

    // Keep only wallets passing the strict filter (also re-check cached ones)
    const passing = results.filter((w) => w.totalPnlUsd > 0 && w.winRate >= 60);
    const sorted = passing.sort((a, b) => b.score - a.score).slice(0, 20);

    let finalList = sorted;
    if (lastGoodScan) {
      const have = new Set(sorted.map((w) => w.address));
      const carryOver = lastGoodScan.wallets.filter(
        (w) =>
          !have.has(w.address) &&
          w.totalPnlUsd > 0 &&
          w.winRate >= 60 &&
          Date.now() / 1000 - w.lastActivity < 6 * 3600
      );
      finalList = [...sorted, ...carryOver].sort((a, b) => b.score - a.score).slice(0, 25);
    }

    if (finalList.length > 0) {
      lastGoodScan = {
        wallets: finalList,
        ts: Date.now(),
        scannedPairs: pairs.length,
        scannedWallets: candidates.length,
      };
    }

    const scanInfo = {
      scannedPairs: pairs.length,
      scannedWallets: candidates.length,
      passedFilter: passing.length,
      rejected: rejectedCount,
      heliusRequests,
      durationSec: Math.round((Date.now() - scanStart) / 1000),
    };

    if (!finalList.length) {
      return NextResponse.json({
        wallets: [],
        real: true,
        hasApiKey: true,
        ...scanInfo,
        message: `Проверено ${candidates.length} кошельков — ни один не прошёл фильтр (PnL > 0 и Win Rate ≥ 60%). Попробуй позже, когда на рынке будет больше активности.`,
      });
    }

    return NextResponse.json({
      wallets: finalList,
      real: true,
      hasApiKey: true,
      ...scanInfo,
    });
  } catch (e) {
    console.error("Scanner error:", e);
    return respondWithFallback("Ошибка сканирования — показаны последние результаты");
  }
}

function respondWithFallback(message: string) {
  if (lastGoodScan && lastGoodScan.wallets.length) {
    return NextResponse.json({
      wallets: lastGoodScan.wallets,
      real: true,
      hasApiKey: true,
      cached: true,
      message,
      scannedPairs: lastGoodScan.scannedPairs,
      scannedWallets: lastGoodScan.scannedWallets,
    });
  }
  return NextResponse.json({ wallets: [], real: true, hasApiKey: true, message });
}

function getDemoWallets(): SmartWallet[] {
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
        { mint: "", symbol: "BOME", buyUsd: 4400, sellUsd: 3600, pnlUsd: -800, pnlPct: -18.2, buyCount: 2, sellCount: 2, holdMinutes: 60, lastTs: now - 21600, status: "closed" },
      ],
    },
  ];
}
