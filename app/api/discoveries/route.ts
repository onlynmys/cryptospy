import { NextResponse } from "next/server";

// Proxies the discovery-server running on our own VM (plain HTTP) so the browser
// only ever talks to our HTTPS Vercel origin — avoids mixed-content blocking and
// keeps the VM's URL/secret off the client entirely.
export async function GET() {
  const base = process.env.DISCOVERY_SERVER_URL;

  if (!base) {
    return NextResponse.json({ discoveries: [], lastScanTs: 0, unavailable: true, message: "DISCOVERY_SERVER_URL не настроен" });
  }

  try {
    const r = await fetch(`${base}/discoveries`, { signal: AbortSignal.timeout(8000), cache: "no-store" });
    if (!r.ok) {
      return NextResponse.json({ discoveries: [], lastScanTs: 0, unavailable: true, message: "Сервис находок недоступен" });
    }
    const data = await r.json();
    return NextResponse.json(data);
  } catch {
    return NextResponse.json({ discoveries: [], lastScanTs: 0, unavailable: true, message: "Сервис находок недоступен" });
  }
}
