import { NextRequest, NextResponse } from "next/server";

// Same proxy pattern as /api/discoveries. POST additionally attaches the shared
// secret server-side — the browser client never sees it.
export async function GET() {
  const base = process.env.DISCOVERY_SERVER_URL;
  if (!base) {
    return NextResponse.json({ minWinRate: 75, minPnlUsd: 3000, maxInactiveHours: 6, minTrades: 3, unavailable: true });
  }
  try {
    const r = await fetch(`${base}/discovery-filters`, { signal: AbortSignal.timeout(8000), cache: "no-store" });
    if (!r.ok) throw new Error("bad response");
    return NextResponse.json(await r.json());
  } catch {
    return NextResponse.json({ minWinRate: 75, minPnlUsd: 3000, maxInactiveHours: 6, minTrades: 3, unavailable: true });
  }
}

export async function POST(req: NextRequest) {
  const base = process.env.DISCOVERY_SERVER_URL;
  const secret = process.env.DISCOVERY_SECRET;

  if (!base || !secret) {
    return NextResponse.json({ error: "not configured" }, { status: 503 });
  }

  try {
    const body = await req.json();
    const r = await fetch(`${base}/discovery-filters?secret=${encodeURIComponent(secret)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) throw new Error("bad response");
    return NextResponse.json(await r.json());
  } catch {
    return NextResponse.json({ error: "failed to update filters" }, { status: 502 });
  }
}
