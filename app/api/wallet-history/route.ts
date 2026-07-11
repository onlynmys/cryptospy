import { NextRequest, NextResponse } from "next/server";

export const maxDuration = 30;

// Proxies to the VM's Helius-free wallet history endpoint (see
// scripts/walletHistory.ts) — a page can take several seconds (staggered
// getTransaction calls against Alchemy's free tier), hence the longer
// timeout than the other, near-instant proxy routes in this folder.
export async function GET(req: NextRequest) {
  const base = process.env.DISCOVERY_SERVER_URL;
  if (!base) {
    return NextResponse.json({ error: "not configured", trades: [], hasMore: false }, { status: 503 });
  }
  const wallet = req.nextUrl.searchParams.get("wallet");
  if (!wallet) {
    return NextResponse.json({ error: "wallet required", trades: [], hasMore: false }, { status: 400 });
  }
  const before = req.nextUrl.searchParams.get("before");
  const limit = req.nextUrl.searchParams.get("limit") || "50";

  try {
    const qs = new URLSearchParams({ wallet, limit });
    if (before) qs.set("before", before);
    const r = await fetch(`${base}/wallet-history?${qs}`, {
      signal: AbortSignal.timeout(25_000),
      cache: "no-store",
    });
    if (!r.ok) throw new Error("bad response");
    return NextResponse.json(await r.json());
  } catch {
    return NextResponse.json({ error: "failed to fetch wallet history", trades: [], hasMore: false }, { status: 502 });
  }
}
