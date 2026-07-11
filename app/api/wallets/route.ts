import { NextRequest, NextResponse } from "next/server";
import { getSolPrice, extractSwap, type HeliusTx } from "@/lib/scannerCore";

const HELIUS_BASE = "https://api.helius.xyz/v0";
const DEX_BASE = "https://api.dexscreener.com";

interface TraderStats {
  address: string;
  shortAddress: string;
  buys: number;
  sells: number;
  totalBuyUsd: number;
  totalSellUsd: number;
  totalPnlUsd: number;
  winRate: number;
  totalTrades: number;
  avgBuyUsd: number;
  lastActivity: number;
  score: number;
  tags: string[];
}

function shortAddr(addr: string) {
  return addr.slice(0, 6) + "..." + addr.slice(-4);
}

function getTags(winRate: number, pnl: number, avgBuy: number, trades: number): string[] {
  const tags: string[] = [];
  if (winRate >= 75) tags.push("🎯 Smart Money");
  if (winRate >= 85) tags.push("🔥 Top Trader");
  if (pnl > 50000) tags.push("💎 Whale");
  if (trades > 100) tags.push("⚡ Active");
  if (avgBuy < 500 && pnl > 5000) tags.push("🚀 Sniper");
  if (tags.length === 0) tags.push("👤 Regular");
  return tags;
}

// Reuse the scanner's shared parser (events.swap only, SOL + wSOL + USDC/USDT
// legs) instead of a local SOL-only copy that silently dropped wSOL- and
// stablecoin-denominated trades, then keep only swaps of THIS token.
function extractTokenSwap(
  tx: HeliusTx,
  tokenAddress: string,
  solPrice: number
): { usd: number; side: "buy" | "sell" } | null {
  const swap = extractSwap(tx, solPrice);
  if (!swap || swap.mint !== tokenAddress) return null;
  return { usd: swap.usd, side: swap.side };
}

async function getRealTradersFromHelius(
  pairAddress: string,
  tokenAddress: string,
  apiKey: string
): Promise<TraderStats[]> {
  const [r, solPrice] = await Promise.all([
    fetch(`${HELIUS_BASE}/addresses/${pairAddress}/transactions?api-key=${apiKey}&type=SWAP&limit=100`),
    getSolPrice(),
  ]);
  if (!r.ok) return [];

  const txns: HeliusTx[] = await r.json();
  if (!Array.isArray(txns) || txns.length === 0) return [];

  const traderMap = new Map<string, { buys: { usd: number; ts: number }[]; sells: { usd: number; ts: number }[] }>();

  for (const tx of txns) {
    const maker = tx.feePayer;
    if (!maker) continue;

    const swap = extractTokenSwap(tx, tokenAddress, solPrice);
    if (!swap || swap.usd < 1) continue;

    if (!traderMap.has(maker)) traderMap.set(maker, { buys: [], sells: [] });
    const trader = traderMap.get(maker)!;

    if (swap.side === "buy") trader.buys.push({ usd: swap.usd, ts: tx.timestamp });
    else trader.sells.push({ usd: swap.usd, ts: tx.timestamp });
  }

  const results: TraderStats[] = [];

  for (const [address, data] of traderMap.entries()) {
    if (data.buys.length === 0) continue;

    const totalBuyUsd = data.buys.reduce((s, t) => s + t.usd, 0);
    const totalSellUsd = data.sells.reduce((s, t) => s + t.usd, 0);
    const pnl = totalSellUsd - totalBuyUsd;
    const trades = data.buys.length + data.sells.length;
    const winRate = data.sells.length > 0
      ? Math.round((data.sells.filter((s) => s.usd > 0).length / Math.max(trades, 1)) * 100)
      : 0;
    const avgBuy = totalBuyUsd / Math.max(data.buys.length, 1);
    const lastActivity = Math.max(
      ...data.buys.map((t) => t.ts),
      ...data.sells.map((t) => t.ts)
    );
    const score = Math.floor(
      winRate * 0.4 +
      Math.min(Math.log10(Math.max(Math.abs(pnl), 1)) * 5, 30) +
      Math.min(trades / 5, 20)
    );

    results.push({
      address,
      shortAddress: shortAddr(address),
      buys: data.buys.length,
      sells: data.sells.length,
      totalBuyUsd: Math.round(totalBuyUsd),
      totalSellUsd: Math.round(totalSellUsd),
      totalPnlUsd: Math.round(pnl),
      winRate,
      totalTrades: trades,
      avgBuyUsd: Math.round(avgBuy),
      lastActivity,
      score,
      tags: getTags(winRate, pnl, avgBuy, trades),
    });
  }

  return results.sort((a, b) => b.score - a.score).slice(0, 15);
}

export async function GET(req: NextRequest) {
  const chain = req.nextUrl.searchParams.get("chain") || "solana";
  const pairAddress = req.nextUrl.searchParams.get("pair");
  const apiKey = process.env.HELIUS_API_KEY;

  if (!pairAddress) {
    return NextResponse.json({ wallets: [], error: "pair required", hasApiKey: !!apiKey });
  }

  // Get pair data from DEX Screener first
  let tokenAddress = "";

  try {
    const r = await fetch(`${DEX_BASE}/latest/dex/pairs/${chain}/${pairAddress}`, {
      next: { revalidate: 30 },
    });
    if (r.ok) {
      const d = await r.json();
      tokenAddress = d.pair?.baseToken?.address || "";
    }
  } catch {
    // ignore
  }

  // Real data via Helius (Solana only)
  if (apiKey && chain === "solana" && pairAddress && tokenAddress) {
    try {
      const traders = await getRealTradersFromHelius(pairAddress, tokenAddress, apiKey);
      if (traders.length > 0) {
        return NextResponse.json({ wallets: traders, real: true, hasApiKey: true });
      }
    } catch (e) {
      console.error("Helius error:", e);
    }
  }

  // No real data available — return empty with info
  return NextResponse.json({
    wallets: [],
    real: false,
    hasApiKey: !!apiKey,
    message: chain === "solana"
      ? apiKey
        ? "Нет данных о сделках для этой пары"
        : "Добавь Helius API ключ в Settings для реального анализа трейдеров"
      : "Анализ кошельков доступен только для Solana (через Helius API)",
  });
}
