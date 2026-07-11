import { NextRequest, NextResponse } from "next/server";

// Same proxy pattern as /api/discoveries — the browser (HTTPS) never talks
// to our VM (HTTP) directly, and the shared secret for writes stays server-side.
export async function GET() {
  const base = process.env.DISCOVERY_SERVER_URL;
  if (!base) {
    return NextResponse.json({ wallets: [], unavailable: true });
  }
  try {
    const r = await fetch(`${base}/watched-wallets`, { signal: AbortSignal.timeout(8000), cache: "no-store" });
    if (!r.ok) throw new Error("bad response");
    return NextResponse.json(await r.json());
  } catch {
    return NextResponse.json({ wallets: [], unavailable: true });
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
    const r = await fetch(`${base}/watched-wallets?secret=${encodeURIComponent(secret)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) throw new Error("bad response");
    return NextResponse.json(await r.json());
  } catch {
    return NextResponse.json({ error: "failed to update watched wallets" }, { status: 502 });
  }
}
