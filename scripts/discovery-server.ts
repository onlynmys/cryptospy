// Standalone service that runs on this VM (NOT on Vercel) so its data survives
// between invocations. Two independent jobs happen here:
//
// 1. Continuous swap collection: Helius pushes every SWAP transaction touching
//    our watched DEX programs to POST /webhook/helius in real time. We keep a
//    rolling in-memory + on-disk log of them (pruned to RETENTION_HOURS). This
//    is the ONLY way to genuinely cover hours of activity on busy programs
//    like Jupiter — pulling history on demand via pagination tops out at a few
//    seconds of coverage per page for those, no matter how many pages you walk.
//
// 2. Discovery scanning: an external cron (cron-job.org) hits GET /trigger
//    every ~30min. We pull candidates from the swap log (not the network),
//    analyze each candidate's own full trade history via Helius, and keep a
//    running "discoveries" list of wallets meeting a separately configurable,
//    stricter filter. GET /candidates also serves the same candidate list to
//    the Vercel-hosted manual Scanner page, so both features share one source
//    of truth instead of Vercel trying (and failing) to re-derive it itself.
//
// Run persistently via: pm2 start ecosystem.config.cjs

import { createServer } from "node:http";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  runFullScan,
  makeFilterFn,
  getSolPrice,
  extractSwapFromRaw,
  type ScanFilters,
  type SmartWallet,
  type WalletCacheEntry,
  type RawHeliusTx,
} from "../lib/scannerCore";

const PORT = Number(process.env.DISCOVERY_PORT || 4001);
const SECRET = process.env.DISCOVERY_SECRET || "";
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "";
const HELIUS_API_KEY = process.env.HELIUS_API_KEY || "";
const DATA_DIR = join(__dirname, "..", "data");
const DISCOVERIES_PATH = join(DATA_DIR, "discoveries.json");
const FILTERS_PATH = join(DATA_DIR, "discovery-filters.json");
const SWAP_LOG_PATH = join(DATA_DIR, "swap-log.json");
const RETENTION_MS = 3 * 24 * 3600 * 1000; // discoveries: keep for at least 3 days
const SWAP_RETENTION_HOURS = 24; // raw swap log: rolling 24h window

const ALLOWED_ORIGINS = new Set([
  "https://cryptospy-pi.vercel.app",
  "http://localhost:3000",
]);

const DEFAULT_DISCOVERY_FILTERS: ScanFilters = {
  minWinRate: 75,
  minPnlUsd: 3000,
  maxInactiveHours: 6,
  minTrades: 3,
};

interface DiscoveryRecord {
  address: string;
  firstSeen: number;
  lastSeen: number;
  wallet: SmartWallet;
}

interface SwapLogEntry {
  ts: number; // seconds, matches Helius tx.timestamp
  wallet: string;
  usd: number;
  side: "buy" | "sell";
}

if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

function loadJson<T>(path: string, fallback: T): T {
  try {
    if (!existsSync(path)) return fallback;
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return fallback;
  }
}

function saveJson(path: string, data: unknown) {
  writeFileSync(path, JSON.stringify(data, null, 2));
}

function loadFilters(): ScanFilters {
  return loadJson<ScanFilters>(FILTERS_PATH, DEFAULT_DISCOVERY_FILTERS);
}

function loadDiscoveries(): DiscoveryRecord[] {
  return loadJson<DiscoveryRecord[]>(DISCOVERIES_PATH, []);
}

function pruneDiscoveries(records: DiscoveryRecord[]): DiscoveryRecord[] {
  const now = Date.now();
  return records.filter((r) => now - r.firstSeen < RETENTION_MS);
}

// ---------- swap log (webhook-fed, in-memory + periodic disk snapshot) ----------

let swapLog: SwapLogEntry[] = loadJson<SwapLogEntry[]>(SWAP_LOG_PATH, []);
let solPriceCache = 170;

function pruneSwapLog() {
  const cutoff = Date.now() / 1000 - SWAP_RETENTION_HOURS * 3600;
  swapLog = swapLog.filter((e) => e.ts >= cutoff);
}

function getCandidates(hours: number, minUsd = 20, limit = 80): string[] {
  const cutoff = Date.now() / 1000 - hours * 3600;
  const activity = new Map<string, { count: number; totalUsd: number }>();

  for (const e of swapLog) {
    if (e.ts < cutoff || e.usd < minUsd) continue;
    const cur = activity.get(e.wallet) || { count: 0, totalUsd: 0 };
    cur.count++;
    cur.totalUsd += e.usd;
    activity.set(e.wallet, cur);
  }

  return Array.from(activity.entries())
    .filter(([, a]) => a.count <= 80) // skip hyperactive bots/market-makers
    .sort((a, b) => b[1].totalUsd - a[1].totalUsd)
    .slice(0, limit)
    .map(([addr]) => addr);
}

// Refresh SOL price every 2 min instead of hitting DEX Screener on every webhook delivery
setInterval(() => { getSolPrice().then((p) => { solPriceCache = p; }).catch(() => {}); }, 2 * 60_000);
getSolPrice().then((p) => { solPriceCache = p; }).catch(() => {});

// Prune + persist the swap log periodically
setInterval(() => { pruneSwapLog(); saveJson(SWAP_LOG_PATH, swapLog); }, 60_000);
pruneSwapLog();

// ---------- discovery scanning ----------

const walletCache = new Map<string, WalletCacheEntry>();

let scanning = false;
let loggedSample = false;
let lastScanTs = 0;
let lastScanInfo: Record<string, unknown> | null = null;

async function runDiscoveryScan(): Promise<{ ok: boolean; newCount: number; totalCount: number; info: unknown }> {
  if (scanning) return { ok: false, newCount: 0, totalCount: 0, info: { error: "already scanning" } };
  if (!HELIUS_API_KEY) return { ok: false, newCount: 0, totalCount: 0, info: { error: "no HELIUS_API_KEY set" } };

  scanning = true;
  try {
    const filters = loadFilters();
    const candidates = getCandidates(filters.maxInactiveHours);
    const { allAnalyzed, scanInfo } = await runFullScan(HELIUS_API_KEY, candidates, walletCache);

    const passes = makeFilterFn(filters);
    const qualifying = allAnalyzed.filter(passes);

    const existing = loadDiscoveries();
    const byAddress = new Map(existing.map((r) => [r.address, r]));
    let newCount = 0;
    const now = Date.now();

    for (const w of qualifying) {
      const prev = byAddress.get(w.address);
      if (prev) {
        prev.wallet = w;
        prev.lastSeen = now;
      } else {
        byAddress.set(w.address, { address: w.address, firstSeen: now, lastSeen: now, wallet: w });
        newCount++;
      }
    }

    const pruned = pruneDiscoveries(Array.from(byAddress.values()))
      .sort((a, b) => b.wallet.score - a.wallet.score);

    saveJson(DISCOVERIES_PATH, pruned);

    lastScanTs = now;
    lastScanInfo = { ...scanInfo, candidatesFromLog: candidates.length, swapLogSize: swapLog.length, qualifying: qualifying.length };

    return { ok: true, newCount, totalCount: pruned.length, info: lastScanInfo };
  } finally {
    scanning = false;
  }
}

function withCors(origin: string | undefined, res: import("node:http").ServerResponse) {
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

const server = createServer(async (req, res) => {
  const origin = req.headers.origin;
  withCors(origin, res);

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url || "/", `http://localhost:${PORT}`);

  try {
    // Helius calls this on every SWAP transaction touching our watched programs.
    if (url.pathname === "/webhook/helius" && req.method === "POST") {
      if (!WEBHOOK_SECRET || req.headers.authorization !== WEBHOOK_SECRET) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "unauthorized" }));
        return;
      }

      let body = "";
      for await (const chunk of req) body += chunk;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));

      if (process.env.LOG_RAW_WEBHOOK === "1" && !loggedSample) {
        loggedSample = true;
        writeFileSync(join(DATA_DIR, "raw-webhook-sample.json"), body);
        console.log("logged raw webhook sample to data/raw-webhook-sample.json");
      }

      try {
        const txs = JSON.parse(body) as RawHeliusTx[];
        let added = 0;
        for (const tx of Array.isArray(txs) ? txs : []) {
          const swap = extractSwapFromRaw(tx, solPriceCache);
          if (!swap || swap.usd < 20) continue;
          swapLog.push({ ts: swap.ts, wallet: swap.wallet, usd: Math.round(swap.usd), side: swap.side });
          added++;
        }
        if (added) console.log(`webhook: +${added} swaps (log size ${swapLog.length})`);
      } catch (e) {
        console.error("webhook parse error:", e);
      }
      return;
    }

    if (url.pathname === "/trigger" && req.method === "GET") {
      if (url.searchParams.get("secret") !== SECRET || !SECRET) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "unauthorized" }));
        return;
      }
      const result = await runDiscoveryScan();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
      return;
    }

    // Candidates derived from the live swap log — consumed by the Vercel-hosted
    // manual Scanner page (proxied) as well as used internally above.
    if (url.pathname === "/candidates" && req.method === "GET") {
      const hours = Number(url.searchParams.get("hours") || "6") || 6;
      const candidates = getCandidates(hours);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ candidates, swapLogSize: swapLog.length, hours }));
      return;
    }

    if (url.pathname === "/discoveries" && req.method === "GET") {
      const records = pruneDiscoveries(loadDiscoveries());
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        discoveries: records,
        lastScanTs,
        lastScanInfo,
      }));
      return;
    }

    if (url.pathname === "/discovery-filters" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(loadFilters()));
      return;
    }

    if (url.pathname === "/discovery-filters" && req.method === "POST") {
      if (url.searchParams.get("secret") !== SECRET || !SECRET) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "unauthorized" }));
        return;
      }
      let body = "";
      for await (const chunk of req) body += chunk;
      const next = JSON.parse(body) as Partial<ScanFilters>;
      const current = loadFilters();
      const merged: ScanFilters = { ...current, ...next };
      saveJson(FILTERS_PATH, merged);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(merged));
      return;
    }

    if (url.pathname === "/health" && req.method === "GET") {
      const oldest = swapLog.length ? Math.round((Date.now() / 1000 - swapLog[0].ts) / 60) : 0;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, lastScanTs, scanning, swapLogSize: swapLog.length, oldestSwapMinutesAgo: oldest }));
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  } catch (e) {
    console.error("discovery-server error:", e);
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "server error" }));
  }
});

server.listen(PORT, () => {
  console.log(`discovery-server listening on :${PORT}`);
  console.log(`HELIUS_API_KEY set: ${!!HELIUS_API_KEY}`);
  console.log(`DISCOVERY_SECRET set: ${!!SECRET}`);
  console.log(`WEBHOOK_SECRET set: ${!!WEBHOOK_SECRET}`);
  console.log(`swap log loaded: ${swapLog.length} entries`);
});
