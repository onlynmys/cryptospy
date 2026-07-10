import { NextRequest, NextResponse } from "next/server";

const BASE = "https://api.dexscreener.com";

export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams.get("q");
  const address = req.nextUrl.searchParams.get("address");
  const chain = req.nextUrl.searchParams.get("chain");
  const pair = req.nextUrl.searchParams.get("pair");

  try {
    if (pair && chain) {
      const r = await fetch(`${BASE}/latest/dex/pairs/${chain}/${pair}`);
      if (!r.ok) return NextResponse.json({ pairs: [], trades: [] });
      const d = await r.json();
      return NextResponse.json({
        pair: d.pair || null,
        trades: d.pair?.txns?.recent || [],
      });
    }

    if (address) {
      const r = await fetch(`${BASE}/latest/dex/tokens/${address}`);
      if (!r.ok) return NextResponse.json({ pairs: [] });
      const d = await r.json();
      return NextResponse.json({ pairs: d.pairs || [] });
    }

    if (q) {
      const r = await fetch(`${BASE}/latest/dex/search?q=${encodeURIComponent(q)}`);
      if (!r.ok) return NextResponse.json({ pairs: [] });
      const d = await r.json();
      return NextResponse.json({ pairs: (d.pairs || []).slice(0, 20) });
    }

    return NextResponse.json({ pairs: [] });
  } catch (e) {
    console.error(e);
    return NextResponse.json({ pairs: [] });
  }
}
