import { NextRequest, NextResponse } from "next/server";

export async function GET(req: NextRequest) {
  const base = process.env.DISCOVERY_SERVER_URL;
  if (!base) {
    return NextResponse.json({ activity: [], unavailable: true });
  }
  const limit = req.nextUrl.searchParams.get("limit") || "50";
  try {
    const r = await fetch(`${base}/wallet-activity?limit=${limit}`, { signal: AbortSignal.timeout(8000), cache: "no-store" });
    if (!r.ok) throw new Error("bad response");
    return NextResponse.json(await r.json());
  } catch {
    return NextResponse.json({ activity: [], unavailable: true });
  }
}
