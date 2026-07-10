import { NextRequest, NextResponse } from "next/server";

// Allow up to 60s for scanning (Vercel fluid compute)
export const maxDuration = 60;

const DEX = "https://api.dexscreener.com";
const HELIUS = "https://api.helius.xyz/v0";
const WSOL = "So11111111111111111111111111111111111111112";

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
  score: number;
  tags: string[];
  recentBuys: RecentBuy[];
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
        // rate limited — back off and retry
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

// Run tasks with limited concurrency to respect Helius 10 req/s limit
async function pool<T, R>(items: T[], concurrency: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  let idx = 0;
  async function worker() {
    while (idx < items.length) {
      const i = idx++;
      results[i] = await fn(items[i]);
      await sleep(150); // spacing between requests per worker
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

  // DEX Screener allows up to 30 addresses per request
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
      }
    } catch { /* ignore */ }
  }

  // Dedupe by pair, sort by 1h volume
  const seen = new Set<string>();
  return pairs
    .filter((p) => !seen.has(p.pairAddress) && seen.add(p.pairAddress))
    .sort((a, b) => b.volumeH1 - a.volumeH1)
    .slice(0, 8);
}

// ---------- wallet analysis ----------

interface TokenPosition {
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

  // Fallback via transfers
  const solSent = (tx.nativeTransfers || []).filter((t) => t.fromUserAccount === wallet).reduce((s, t) => s + t.amount, 0) / 1e9;
  const solRecv = (tx.nativeTransfers || []).filter((t) => t.toUserAccount === wallet).reduce((s, t) => s + t.amount, 0) / 1e9;
  const tokRecv = (tx.tokenTransfers || []).find((t) => t.toUserAccount === wallet && t.mint !== WSOL);
  const tokSent = (tx.tokenTransfers || []).find((t) => t.fromUserAccount === wallet && t.mint !== WSOL);

  if (solSent > 0.002 && tokRecv) return { mint: tokRecv.mint, usd: solSent * solPrice, side: "buy" };
  if (solRecv > 0.002 && tokSent) return { mint: tokSent.mint, usd: solRecv * solPrice, side: "sell" };
  return null;
}

function analyzeWallet(txns: HeliusTx[], wallet: string, solPrice: number) {
  const positions = new Map<string, TokenPosition>();

  for (const tx of txns) {
    const swap = extractSwap(tx, wallet, solPrice);
    if (!swap || swap.usd < 1) continue;
    if (!positions.has(swap.mint)) positions.set(swap.mint, { buys: [], sells: [] });
    const pos = positions.get(swap.mint)!;
    if (swap.side === "buy") pos.buys.push({ usd: swap.usd, ts: tx.timestamp });
    else pos.sells.push({ usd: swap.usd, ts: tx.timestamp });
  }

  let wins = 0, losses = 0, realizedPnl = 0, totalBuyUsd = 0, buyCount = 0;
  const holdTimes: number[] = [];

  for (const pos of positions.values()) {
    const buyUsd = pos.buys.reduce((s, t) => s + t.usd, 0);
    const sellUsd = pos.sells.reduce((s, t) => s + t.usd, 0);
    totalBuyUsd += buyUsd;
    buyCount += pos.buys.length;

    // Closed (or partially closed) position → realized PnL
    if (pos.buys.length && pos.sells.length) {
      const pnl = sellUsd - buyUsd;
      realizedPnl += pnl;
      if (pnl > 0) wins++; else losses++;
      const firstBuy = Math.min(...pos.buys.map((t) => t.ts));
      const lastSell = Math.max(...pos.sells.map((t) => t.ts));
      if (lastSell > firstBuy) holdTimes.push((lastSell - firstBuy) / 60);
    }
  }

  return {
    wins,
    losses,
    totalPnlUsd: realizedPnl,
    avgBuyUsd: buyCount ? totalBuyUsd / buyCount : 0,
    avgHoldMinutes: holdTimes.length ? holdTimes.reduce((a, b) => a + b, 0) / holdTimes.length : 0,
    lastActivity: txns.length ? Math.max(...txns.map((t) => t.timestamp)) : 0,
    openPositions: Array.from(positions.values()).filter((p) => p.buys.length && !p.sells.length).length,
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

// ---------- caching (module-level, survives warm invocations) ----------

const walletCache = new Map<string, { data: SmartWallet; ts: number }>();
let lastGoodScan: { wallets: SmartWallet[]; ts: number; scannedPairs: number; scannedWallets: number } | null = null;
const WALLET_TTL = 20 * 60 * 1000;
const SCAN_TTL = 3 * 60 * 1000;

// ---------- main handler ----------

export async function GET(req: NextRequest) {
  const apiKey = process.env.HELIUS_API_KEY;
  const forceRefresh = req.nextUrl.searchParams.get("refresh") === "1";

  if (!apiKey) {
    return NextResponse.json({
      wallets: getDemoWallets(),
      real: false,
      hasApiKey: false,
      message: "Добавь Helius API ключ в Settings для реального сканирования",
    });
  }

  // Serve recent scan from cache (avoids hammering Helius on every page load)
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

  try {
    const [solPrice, pairs] = await Promise.all([getSolPrice(), getActivePairs()]);

    if (!pairs.length) {
      return respondWithFallback("Нет активных пар для сканирования");
    }

    // Step 1: pull recent swaps from top pairs (concurrency 3, respects rate limit)
    const pairTxLists = await pool(pairs, 3, (p) =>
      heliusFetch(`${HELIUS}/addresses/${p.pairAddress}/transactions?api-key=${apiKey}&type=SWAP&limit=100`)
    );

    // Step 2: collect wallet candidates + their recent buys on these pairs
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

    // Prioritize wallets seen buying on multiple pairs or with bigger buys
    const candidates = Array.from(walletBuys.entries())
      .sort((a, b) => {
        const aScore = a[1].length * 1000 + Math.max(...a[1].map((x) => x.buyAmountUsd));
        const bScore = b[1].length * 1000 + Math.max(...b[1].map((x) => x.buyAmountUsd));
        return bScore - aScore;
      })
      .slice(0, 25)
      .map(([addr]) => addr);

    // Step 3: analyze each candidate's trade history (use cache when fresh)
    const results: SmartWallet[] = [];
    const toFetch: string[] = [];

    for (const addr of candidates) {
      const cached = walletCache.get(addr);
      if (cached && Date.now() - cached.ts < WALLET_TTL) {
        // refresh recentBuys from this scan
        cached.data.recentBuys = walletBuys.get(addr) || cached.data.recentBuys;
        results.push(cached.data);
      } else {
        toFetch.push(addr);
      }
    }

    const walletTxLists = await pool(toFetch, 3, (addr) =>
      heliusFetch(`${HELIUS}/addresses/${addr}/transactions?api-key=${apiKey}&type=SWAP&limit=100`)
    );

    toFetch.forEach((addr, i) => {
      const txns = walletTxLists[i] || [];
      if (txns.length < 2) return;

      const stats = analyzeWallet(txns, addr, solPrice);
      const totalTrades = stats.wins + stats.losses;

      // Need at least 1 closed trade to judge
      if (totalTrades < 1) return;

      const winRate = Math.round((stats.wins / totalTrades) * 100);

      // Keep only profitable-looking wallets
      if (stats.totalPnlUsd <= 0 && winRate < 50) return;

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
        recentBuys: walletBuys.get(addr) || [],
      };

      const score = calcScore(partial);
      const wallet: SmartWallet = { ...partial, score, tags: [] };
      wallet.tags = calcTags(wallet);

      walletCache.set(addr, { data: wallet, ts: Date.now() });
      results.push(wallet);
    });

    const sorted = results.sort((a, b) => b.score - a.score).slice(0, 20);

    // Merge with previous scan so the list grows over time instead of shrinking
    let finalList = sorted;
    if (lastGoodScan) {
      const have = new Set(sorted.map((w) => w.address));
      const carryOver = lastGoodScan.wallets.filter(
        (w) => !have.has(w.address) && Date.now() / 1000 - w.lastActivity < 6 * 3600
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

    if (!finalList.length) {
      return respondWithFallback("Сканирование не нашло подходящих кошельков — попробуй через пару минут");
    }

    return NextResponse.json({
      wallets: finalList,
      real: true,
      hasApiKey: true,
      scannedPairs: pairs.length,
      scannedWallets: candidates.length,
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
      avgBuyUsd: 1200, avgHoldMinutes: 18, lastActivity: now - 1200, score: 92,
      tags: ["🔥 Top Trader", "💰 Profitable", "⚡ Sniper"],
      recentBuys: [
        { tokenSymbol: "BONK", tokenAddress: "", pairAddress: "", buyAmountUsd: 2400, buyTime: now - 3600, priceChangeAfter: 34.2, status: "sold_profit" },
        { tokenSymbol: "WIF", tokenAddress: "", pairAddress: "", buyAmountUsd: 1800, buyTime: now - 7200, priceChangeAfter: 18.7, status: "sold_profit" },
      ],
    },
    {
      address: "GThUX1Atko4tqhN2NaiTazWSeFWMuiUvfFnyJyUghFMJ",
      winRate: 78, totalPnlUsd: 84200, totalTrades: 134, wins: 104, losses: 30,
      avgBuyUsd: 650, avgHoldMinutes: 45, lastActivity: now - 2700, score: 85,
      tags: ["🎯 Smart Money", "💰 Profitable", "🏃 Flipper"],
      recentBuys: [
        { tokenSymbol: "MEW", tokenAddress: "", pairAddress: "", buyAmountUsd: 1100, buyTime: now - 1800, priceChangeAfter: 22.5, status: "sold_profit" },
      ],
    },
  ];
}
