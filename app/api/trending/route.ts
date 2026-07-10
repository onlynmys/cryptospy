import { NextRequest, NextResponse } from "next/server";

const BASE = "https://api.dexscreener.com";

export async function GET(req: NextRequest) {
  const chain = req.nextUrl.searchParams.get("chain") || "";
  const mode = req.nextUrl.searchParams.get("mode") || "trending";

  try {
    let pairs: unknown[] = [];

    if (mode === "boosted") {
      const r = await fetch(`${BASE}/token-boosts/top/v1`, {
        next: { revalidate: 120 },
      });
      if (r.ok) {
        const boosted = await r.json() as { tokenAddress: string; chainId: string }[];
        const filtered = boosted
          .filter((b) => !chain || b.chainId === chain)
          .slice(0, 20);
        const addrs = filtered.map((b) => b.tokenAddress).join(",");
        if (addrs) {
          const r2 = await fetch(`${BASE}/latest/dex/tokens/${addrs}`, {
            next: { revalidate: 60 },
          });
          if (r2.ok) {
            const d = await r2.json();
            pairs = d.pairs || [];
          }
        }
      }
    } else {
      // trending via profiles
      const r = await fetch(`${BASE}/token-profiles/latest/v1`, {
        next: { revalidate: 60 },
      });
      if (r.ok) {
        const profiles = await r.json() as { tokenAddress: string; chainId: string }[];
        const filtered = profiles
          .filter((p) => !chain || p.chainId === chain)
          .slice(0, 30);
        const addrs = filtered.map((p) => p.tokenAddress).join(",");
        if (addrs) {
          const r2 = await fetch(`${BASE}/latest/dex/tokens/${addrs}`, {
            next: { revalidate: 60 },
          });
          if (r2.ok) {
            const d = await r2.json();
            pairs = d.pairs || [];
          }
        }
      }
    }

    // Filter and sort by volume
    const filtered = (pairs as { volume?: { h24?: number }; chainId?: string }[])
      .filter((p) => !chain || p.chainId === chain)
      .filter((p) => p.volume?.h24 && p.volume.h24 > 1000)
      .sort((a, b) => (b.volume?.h24 || 0) - (a.volume?.h24 || 0))
      .slice(0, 50);

    return NextResponse.json({ pairs: filtered });
  } catch (e) {
    console.error(e);
    return NextResponse.json({ pairs: [] });
  }
}
