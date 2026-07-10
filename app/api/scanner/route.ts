import { NextRequest, NextResponse } from "next/server";

const DEX = "https://api.dexscreener.com";
const HELIUS = "https://api.helius.xyz/v0";

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
  priceChangeAfter?: number; // % gain after buy
  status: "holding" | "sold_profit" | "sold_loss";
}

interface HeliusTx {
  signature: string;
  timestamp: number;
  feePayer: string;
  type: string;
  description: string;
  tokenTransfers?: {
    mint: string;
    fromUserAccount: string;
    toUserAccount: string;
    tokenAmount: number;
    tokenStandard?: string;
  }[];
  nativeTransfers?: {
    fromUserAccount: string;
    toUserAccount: string;
    amount: number;
  }[];
  events?: {
    swap?: {
      nativeInput?: { account: string; amount: number };
      nativeOutput?: { account: string; amount: number };
      tokenInputs?: { userAccount: string; mint: string; rawTokenAmount: { tokenAmount: string } }[];
      tokenOutputs?: { userAccount: string; mint: string; rawTokenAmount: { tokenAmount: string } }[];
    };
  };
}

function shortAddr(a: string) { return a.slice(0, 6) + "..." + a.slice(-4); }

function calcScore(w: Omit<SmartWallet, "score" | "tags">): number {
  const winScore = w.winRate * 0.4;
  const pnlScore = Math.min(Math.log10(Math.max(w.totalPnlUsd, 1)) * 6, 30);
  const tradesScore = Math.min(w.totalTrades * 0.05, 15);
  const recencyScore = (Date.now() / 1000 - w.lastActivity) < 3600 ? 10 : 0;
  return Math.round(winScore + pnlScore + tradesScore + recencyScore);
}

function calcTags(w: SmartWallet): string[] {
  const tags: string[] = [];
  if (w.winRate >= 80) tags.push("🔥 Top Trader");
  else if (w.winRate >= 65) tags.push("🎯 Smart Money");
  if (w.totalPnlUsd > 100_000) tags.push("💎 Whale");
  else if (w.totalPnlUsd > 20_000) tags.push("💰 Profitable");
  if (w.avgHoldMinutes < 30) tags.push("⚡ Sniper");
  else if (w.avgHoldMinutes < 120) tags.push("🏃 Flipper");
  if (w.totalTrades > 100) tags.push("🔄 Active");
  if (tags.length === 0) tags.push("📊 Trader");
  return tags;
}

async function fetchPairTransactions(pairAddress: string, apiKey: string): Promise<HeliusTx[]> {
  try {
    const url = `${HELIUS}/addresses/${pairAddress}/transactions?api-key=${apiKey}&type=SWAP&limit=100`;
    const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) return [];
    return await r.json();
  } catch { return []; }
}

async function fetchWalletTransactions(wallet: string, apiKey: string): Promise<HeliusTx[]> {
  try {
    const url = `${HELIUS}/addresses/${wallet}/transactions?api-key=${apiKey}&type=SWAP&limit=50`;
    const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) return [];
    return await r.json();
  } catch { return []; }
}

async function getTrendingPairs(): Promise<{ pairAddress: string; tokenSymbol: string; tokenAddress: string; volumeSpike: number; priceChange5m: number }[]> {
  try {
    const r = await fetch(`${DEX}/token-profiles/latest/v1`, { next: { revalidate: 60 } });
    if (!r.ok) return [];
    const profiles = await r.json() as { tokenAddress: string; chainId: string }[];
    const solanaMints = profiles.filter((p) => p.chainId === "solana").slice(0, 20).map((p) => p.tokenAddress);
    if (!solanaMints.length) return [];

    const r2 = await fetch(`${DEX}/latest/dex/tokens/${solanaMints.join(",")}`, { next: { revalidate: 60 } });
    if (!r2.ok) return [];
    const d = await r2.json();
    const pairs = (d.pairs || []) as {
      pairAddress: string;
      baseToken: { symbol: string; address: string };
      volume?: { m5?: number; h1?: number };
      priceChange?: { m5?: number };
      liquidity?: { usd?: number };
    }[];

    return pairs
      .filter((p) => (p.liquidity?.usd || 0) > 5000 && (p.volume?.h1 || 0) > 1000)
      .map((p) => ({
        pairAddress: p.pairAddress,
        tokenSymbol: p.baseToken.symbol,
        tokenAddress: p.baseToken.address,
        volumeSpike: p.volume?.h1 ? (p.volume?.m5 || 0) / p.volume.h1 : 0,
        priceChange5m: p.priceChange?.m5 || 0,
      }))
      .sort((a, b) => b.volumeSpike - a.volumeSpike)
      .slice(0, 10);
  } catch { return []; }
}

function analyzeWalletTrades(
  txns: HeliusTx[],
  walletAddr: string,
  solPriceUsd: number
): { wins: number; losses: number; totalPnlUsd: number; avgBuyUsd: number; avgHoldMinutes: number; lastActivity: number } {
  // Group by token mint: find buy→sell pairs
  const tokenTrades = new Map<string, { buys: { usd: number; ts: number }[]; sells: { usd: number; ts: number }[] }>();

  for (const tx of txns) {
    const swapEvent = tx.events?.swap;
    const ts = tx.timestamp;

    // Try structured swap event first
    if (swapEvent) {
      const isBuying = swapEvent.nativeInput && swapEvent.tokenOutputs?.length;
      const isSelling = swapEvent.nativeOutput && swapEvent.tokenInputs?.length;

      if (isBuying && swapEvent.nativeInput && swapEvent.tokenOutputs) {
        const usd = (swapEvent.nativeInput.amount / 1e9) * solPriceUsd;
        const mint = swapEvent.tokenOutputs[0]?.mint;
        if (mint && usd > 0) {
          if (!tokenTrades.has(mint)) tokenTrades.set(mint, { buys: [], sells: [] });
          tokenTrades.get(mint)!.buys.push({ usd, ts });
        }
      }
      if (isSelling && swapEvent.nativeOutput && swapEvent.tokenInputs) {
        const usd = (swapEvent.nativeOutput.amount / 1e9) * solPriceUsd;
        const mint = swapEvent.tokenInputs[0]?.mint;
        if (mint && usd > 0) {
          if (!tokenTrades.has(mint)) tokenTrades.set(mint, { buys: [], sells: [] });
          tokenTrades.get(mint)!.sells.push({ usd, ts });
        }
      }
      continue;
    }

    // Fallback: use native + token transfers
    const solSent = (tx.nativeTransfers || [])
      .filter((t) => t.fromUserAccount === walletAddr)
      .reduce((s, t) => s + t.amount, 0) / 1e9;

    const tokenReceived = (tx.tokenTransfers || []).filter((t) => t.toUserAccount === walletAddr);
    const tokenSent = (tx.tokenTransfers || []).filter((t) => t.fromUserAccount === walletAddr);

    if (solSent > 0.001 && tokenReceived.length > 0) {
      const mint = tokenReceived[0].mint;
      const usd = solSent * solPriceUsd;
      if (!tokenTrades.has(mint)) tokenTrades.set(mint, { buys: [], sells: [] });
      tokenTrades.get(mint)!.buys.push({ usd, ts });
    } else if (tokenSent.length > 0) {
      const mint = tokenSent[0].mint;
      const solReceived = (tx.nativeTransfers || [])
        .filter((t) => t.toUserAccount === walletAddr)
        .reduce((s, t) => s + t.amount, 0) / 1e9;
      const usd = solReceived * solPriceUsd;
      if (usd > 0) {
        if (!tokenTrades.has(mint)) tokenTrades.set(mint, { buys: [], sells: [] });
        tokenTrades.get(mint)!.sells.push({ usd, ts });
      }
    }
  }

  let wins = 0, losses = 0, totalPnl = 0, totalBuyUsd = 0, totalBuys = 0;
  const holdTimes: number[] = [];

  for (const [, trades] of tokenTrades.entries()) {
    if (!trades.buys.length) continue;
    const buyUsd = trades.buys.reduce((s, t) => s + t.usd, 0);
    const sellUsd = trades.sells.reduce((s, t) => s + t.usd, 0);
    totalBuyUsd += buyUsd;
    totalBuys += trades.buys.length;

    if (trades.sells.length > 0) {
      const pnl = sellUsd - buyUsd;
      totalPnl += pnl;
      if (pnl > 0) wins++; else losses++;

      if (trades.buys[0] && trades.sells[0]) {
        const holdMin = Math.abs(trades.sells[0].ts - trades.buys[0].ts) / 60;
        if (holdMin > 0) holdTimes.push(holdMin);
      }
    }
  }

  const lastActivity = txns.length > 0 ? Math.max(...txns.map((t) => t.timestamp)) : 0;
  const avgBuyUsd = totalBuys > 0 ? totalBuyUsd / totalBuys : 0;
  const avgHoldMinutes = holdTimes.length > 0 ? holdTimes.reduce((a, b) => a + b, 0) / holdTimes.length : 0;

  return { wins, losses, totalPnlUsd: totalPnl, avgBuyUsd, avgHoldMinutes, lastActivity };
}

// In-memory cache: walletAddress -> stats (per process, resets on cold start)
const walletCache = new Map<string, { data: SmartWallet; ts: number }>();
const CACHE_TTL = 30 * 60 * 1000; // 30 min

export async function GET(req: NextRequest) {
  const apiKey = process.env.HELIUS_API_KEY;
  const forceRefresh = req.nextUrl.searchParams.get("refresh") === "1";

  if (!apiKey) {
    return NextResponse.json({
      wallets: getDemoWallets(),
      real: false,
      hasApiKey: false,
      message: "Добавь Helius API ключ в Settings для реального сканирования смарт-кошельков",
    });
  }

  try {
    // Get trending pairs with volume spikes
    const pairs = await getTrendingPairs();
    if (!pairs.length) {
      return NextResponse.json({ wallets: [], real: true, hasApiKey: true, message: "Нет активных пар для сканирования" });
    }

    // Collect unique wallet addresses from pair transactions
    const walletSet = new Set<string>();
    const walletRecentBuys = new Map<string, RecentBuy[]>();

    for (const pair of pairs.slice(0, 5)) {
      const txns = await fetchPairTransactions(pair.pairAddress, apiKey);

      for (const tx of txns) {
        const maker = tx.feePayer;
        if (!maker || maker.length < 32) continue;

        // Extract if this was a buy (SOL → token)
        const isBuy = (tx.nativeTransfers || []).some((t) => t.fromUserAccount === maker && t.amount > 100000)
          || tx.events?.swap?.nativeInput?.account === maker;

        if (isBuy) {
          walletSet.add(maker);

          const solSent = tx.events?.swap?.nativeInput
            ? tx.events.swap.nativeInput.amount / 1e9
            : (tx.nativeTransfers || []).filter((t) => t.fromUserAccount === maker).reduce((s, t) => s + t.amount, 0) / 1e9;

          const buyUsd = solSent * 170; // rough SOL price

          if (buyUsd > 10) {
            const existing = walletRecentBuys.get(maker) || [];
            existing.push({
              tokenSymbol: pair.tokenSymbol,
              tokenAddress: pair.tokenAddress,
              pairAddress: pair.pairAddress,
              buyAmountUsd: Math.round(buyUsd),
              buyTime: tx.timestamp,
              priceChangeAfter: pair.priceChange5m > 0 ? pair.priceChange5m : undefined,
              status: pair.priceChange5m > 5 ? "sold_profit" : pair.priceChange5m < -5 ? "sold_loss" : "holding",
            });
            walletRecentBuys.set(maker, existing);
          }
        }
      }
    }

    // Analyze each unique wallet
    const results: SmartWallet[] = [];
    const walletsToAnalyze = Array.from(walletSet).slice(0, 30);

    for (const walletAddr of walletsToAnalyze) {
      const cached = walletCache.get(walletAddr);
      if (!forceRefresh && cached && Date.now() - cached.ts < CACHE_TTL) {
        results.push(cached.data);
        continue;
      }

      const walletTxns = await fetchWalletTransactions(walletAddr, apiKey);
      if (walletTxns.length < 3) continue;

      const stats = analyzeWalletTrades(walletTxns, walletAddr, 170);
      const totalTrades = stats.wins + stats.losses;
      if (totalTrades < 2) continue;

      const winRate = Math.round((stats.wins / totalTrades) * 100);
      if (winRate < 50 && stats.totalPnlUsd <= 0) continue; // Skip obvious losers

      const partial = {
        address: walletAddr,
        winRate,
        totalPnlUsd: Math.round(stats.totalPnlUsd),
        totalTrades,
        wins: stats.wins,
        losses: stats.losses,
        avgBuyUsd: Math.round(stats.avgBuyUsd),
        avgHoldMinutes: Math.round(stats.avgHoldMinutes),
        lastActivity: stats.lastActivity,
        recentBuys: (walletRecentBuys.get(walletAddr) || []).slice(0, 5),
      };

      const score = calcScore(partial);
      const wallet: SmartWallet = { ...partial, score, tags: [] };
      wallet.tags = calcTags(wallet);

      walletCache.set(walletAddr, { data: wallet, ts: Date.now() });
      results.push(wallet);
    }

    const sorted = results
      .sort((a, b) => b.score - a.score)
      .slice(0, 20);

    return NextResponse.json({
      wallets: sorted,
      real: true,
      hasApiKey: true,
      scannedPairs: pairs.length,
      scannedWallets: walletsToAnalyze.length,
    });
  } catch (e) {
    console.error("Scanner error:", e);
    return NextResponse.json({ wallets: getDemoWallets(), real: false, hasApiKey: true, error: String(e) });
  }
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
        { tokenSymbol: "POPCAT", tokenAddress: "", pairAddress: "", buyAmountUsd: 900, buyTime: now - 14400, priceChangeAfter: -4.1, status: "holding" },
      ],
    },
    {
      address: "GThUX1Atko4tqhN2NaiTazWSeFWMuiUvfFnyJyUghFMJ",
      winRate: 78, totalPnlUsd: 84200, totalTrades: 134, wins: 104, losses: 30,
      avgBuyUsd: 650, avgHoldMinutes: 45, lastActivity: now - 2700, score: 85,
      tags: ["🎯 Smart Money", "💰 Profitable", "🏃 Flipper"],
      recentBuys: [
        { tokenSymbol: "MEW", tokenAddress: "", pairAddress: "", buyAmountUsd: 1100, buyTime: now - 1800, priceChangeAfter: 22.5, status: "sold_profit" },
        { tokenSymbol: "BOME", tokenAddress: "", pairAddress: "", buyAmountUsd: 750, buyTime: now - 5400, priceChangeAfter: 8.3, status: "holding" },
      ],
    },
    {
      address: "5tzFkiKscXHK5ZXCGbCy9NUTna4HVMGfkJbBFMBBfTb7",
      winRate: 71, totalPnlUsd: 41300, totalTrades: 67, wins: 48, losses: 19,
      avgBuyUsd: 380, avgHoldMinutes: 28, lastActivity: now - 900, score: 76,
      tags: ["🎯 Smart Money", "⚡ Sniper"],
      recentBuys: [
        { tokenSymbol: "JUP", tokenAddress: "", pairAddress: "", buyAmountUsd: 500, buyTime: now - 900, priceChangeAfter: undefined, status: "holding" },
        { tokenSymbol: "MYRO", tokenAddress: "", pairAddress: "", buyAmountUsd: 320, buyTime: now - 3600, priceChangeAfter: 41.2, status: "sold_profit" },
      ],
    },
    {
      address: "HN7cABqLq46Es1jh92dQQisAq662SmxELLLsHHe4YWrH",
      winRate: 66, totalPnlUsd: 19800, totalTrades: 203, wins: 134, losses: 69,
      avgBuyUsd: 220, avgHoldMinutes: 95, lastActivity: now - 4200, score: 68,
      tags: ["📊 Trader", "🔄 Active"],
      recentBuys: [
        { tokenSymbol: "ZEUS", tokenAddress: "", pairAddress: "", buyAmountUsd: 280, buyTime: now - 4200, priceChangeAfter: 12.1, status: "holding" },
      ],
    },
  ];
}
