import { NextRequest, NextResponse } from "next/server";
import {
  HELIUS,
  getSolPrice,
  resolveSymbols,
  extractSwap,
  analyzeWallet,
  type HeliusTx,
} from "@/lib/scannerCore";

export const maxDuration = 30;

// Per-wallet trade history + summary for the Wallets page. Uses the exact
// same parsing pipeline as the scanner (events.swap + live SOL price +
// ownership check), so the numbers here match what the scanner would say
// about the same wallet — this route previously had its own ad-hoc parsing
// that returned a shape the page couldn't even read.

export interface AnalyzedTrade {
  timestamp: number;
  token: string;
  type: "buy" | "sell";
  amountUsd: number;
}

export async function GET(req: NextRequest) {
  const wallet = req.nextUrl.searchParams.get("wallet");
  const apiKey = process.env.HELIUS_API_KEY;

  if (!wallet) {
    return NextResponse.json({ error: "wallet required", trades: [], summary: null });
  }
  if (!apiKey) {
    // No fabricated demo trades here — showing made-up history as if it were
    // real defeats the whole point of the tracker.
    return NextResponse.json({ noKey: true, trades: [], summary: null });
  }

  try {
    const [solPrice, r] = await Promise.all([
      getSolPrice(),
      fetch(`${HELIUS}/addresses/${wallet}/transactions?api-key=${apiKey}&type=SWAP&limit=100`, {
        signal: AbortSignal.timeout(15_000),
      }),
    ]);
    if (!r.ok) return NextResponse.json({ error: "helius error", trades: [], summary: null });
    const txns = (await r.json()) as HeliusTx[];
    if (!Array.isArray(txns)) return NextResponse.json({ error: "helius error", trades: [], summary: null });

    const swaps = txns
      .map((tx) => ({ tx, swap: extractSwap(tx, solPrice, wallet) }))
      .filter((s): s is { tx: HeliusTx; swap: NonNullable<ReturnType<typeof extractSwap>> } => !!s.swap && s.swap.usd >= 1);

    const symbols = await resolveSymbols(Array.from(new Set(swaps.map((s) => s.swap.mint))).slice(0, 60));

    const trades: AnalyzedTrade[] = swaps
      .map(({ tx, swap }) => ({
        timestamp: tx.timestamp,
        token: symbols.get(swap.mint) || swap.mint.slice(0, 4) + "..." + swap.mint.slice(-4),
        type: swap.side,
        amountUsd: Math.round(swap.usd),
      }))
      .sort((a, b) => b.timestamp - a.timestamp);

    const stats = analyzeWallet(txns, solPrice, wallet);
    const totalTrades = stats.wins + stats.losses;
    const summary = totalTrades > 0 || trades.length > 0
      ? {
          winRate: totalTrades > 0 ? Math.round((stats.wins / totalTrades) * 100) : 0,
          totalTrades,
          totalPnlUsd: Math.round(stats.totalPnlUsd),
          avgBuyUsd: Math.round(stats.avgBuyUsd),
          lastActivity: stats.lastActivity,
          openPositions: stats.openPositions,
        }
      : null;

    return NextResponse.json({ wallet, trades, summary });
  } catch (e) {
    console.error("wallet-analysis error:", e);
    return NextResponse.json({ error: "server error", trades: [], summary: null });
  }
}
