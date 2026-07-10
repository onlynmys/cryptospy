import { NextRequest, NextResponse } from "next/server";

const HELIUS_BASE = "https://api.helius.xyz/v0";

export async function GET(req: NextRequest) {
  const wallet = req.nextUrl.searchParams.get("wallet");
  const apiKey = req.nextUrl.searchParams.get("key") || process.env.HELIUS_API_KEY;

  if (!wallet) {
    return NextResponse.json({ error: "wallet required" });
  }

  if (!apiKey) {
    // Return demo data if no API key
    return NextResponse.json({ demo: true, wallet, trades: getDemoTrades(wallet) });
  }

  try {
    const r = await fetch(
      `${HELIUS_BASE}/addresses/${wallet}/transactions?api-key=${apiKey}&type=SWAP&limit=50`
    );
    if (!r.ok) return NextResponse.json({ error: "helius error", trades: [] });
    const txns = await r.json();

    const trades = txns
      .filter((t: { type: string }) => t.type === "SWAP")
      .map((t: { timestamp: number; description: string; nativeTransfers?: unknown[]; tokenTransfers?: { mint: string; tokenAmount: number; toUserAccount: string; fromUserAccount: string }[] }) => ({
        timestamp: t.timestamp,
        description: t.description,
        tokenTransfers: t.tokenTransfers || [],
      }));

    return NextResponse.json({ wallet, trades });
  } catch (e) {
    console.error(e);
    return NextResponse.json({ error: "server error", trades: [] });
  }
}

function getDemoTrades(wallet: string) {
  const tokens = ["BONK", "WIF", "POPCAT", "MEW", "MYRO", "BOME"];
  const trades = [];
  const seed = wallet.charCodeAt(0) + wallet.charCodeAt(2);

  for (let i = 0; i < 20; i++) {
    const ts = Math.floor(Date.now() / 1000) - i * 3600 * (1 + (seed % 3));
    const token = tokens[(i + seed) % tokens.length];
    const isBuy = i % 3 !== 0;
    const amount = (100 + ((i * seed * 7) % 5000));

    trades.push({
      timestamp: ts,
      token,
      type: isBuy ? "buy" : "sell",
      amountUsd: amount,
      priceChange: isBuy ? null : (20 + (i * 13) % 400),
    });
  }

  return trades;
}
