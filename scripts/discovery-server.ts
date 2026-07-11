// Standalone service that runs on this VM (NOT on Vercel) so its data survives
// between invocations. Two independent jobs happen here:
//
// 1. Continuous swap collection: polls Alchemy's free-tier Solana RPC (see
//    solanaFeed.ts) for new signatures on our watched DEX programs every
//    ~12s, then fetches each new transaction — genuinely $0, no Helius
//    credits. (Tried a Helius webhook first — even "raw" mode burned credits
//    far faster than expected. Then tried Solana's public RPC directly —
//    got the whole IP rate-limited/banned within ~90s even at a trickle.
//    Alchemy's free WebSocket rejects every subscription method, but plain
//    HTTP polling works fine, hence this design.) Keeps a rolling in-memory
//    + on-disk log of parsed swaps (pruned to SWAP_RETENTION_HOURS).
//
// 2. Discovery scanning: an external cron (cron-job.org) hits GET /trigger
//    every ~30min. We pull candidates from the swap log (free), then analyze
//    each candidate's own full trade history via Helius (this part still
//    needs Helius — it's a small, bounded number of calls per run, not a
//    firehose) and keep a running "discoveries" list of wallets meeting a
//    separately configurable, stricter filter. GET /candidates also serves
//    the same candidate list to the Vercel-hosted manual Scanner page.
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
  resolveSymbols,
  type ScanFilters,
  type SmartWallet,
  type WalletCacheEntry,
} from "../lib/scannerCore";
import { startSolanaFeed, type FeedStats } from "./solanaFeed";
import { fetchWalletHistoryPage } from "./walletHistory";

const PORT = Number(process.env.DISCOVERY_PORT || 4001);
const SECRET = process.env.DISCOVERY_SECRET || "";
const HELIUS_API_KEY = process.env.HELIUS_API_KEY || "";
const ALCHEMY_API_KEY = process.env.ALCHEMY_API_KEY || "";
const ALCHEMY_RPC_URL = `https://solana-mainnet.g.alchemy.com/v2/${ALCHEMY_API_KEY}`;

// Confirmed working via getSignaturesForAddress on Alchemy's free tier.
// Jupiter and PumpSwap consistently return empty results at the PROGRAM
// level (retested multiple times, minutes apart) while every other program
// here worked — looks like a deliberate exclusion of the single
// highest-volume addresses on the free tier. Individual PAIR/pool accounts
// don't hit this exclusion though (confirmed: a specific PumpSwap pair and a
// specific Meteora DLMM pair both returned real data), so PumpSwap coverage
// comes from watching currently-trending pair addresses directly instead of
// the whole program — see fetchTrendingPumpswapPairs() below. Jupiter has no
// equivalent "pair" of its own (it's a router, not a pool) — its routed
// swaps still touch Raydium/Orca pool accounts, which we already watch, so
// a meaningful chunk of Jupiter-routed activity is captured indirectly.
const POLL_FEED_SOURCES = [
  { name: "Raydium AMM", address: "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8" },
  { name: "Raydium CLMM", address: "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK" },
  { name: "Pump.fun", address: "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P" },
  { name: "Orca Whirlpool", address: "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc" },
];

// Refreshed periodically with currently-trending PumpSwap/Meteora pair
// addresses (via DEX Screener, which we already use elsewhere — free, no
// key needed) so the free-tier program-level exclusion doesn't leave those
// two venues completely uncovered.
let dynamicPairs: string[] = [];

async function refreshDynamicPairs() {
  try {
    const [boostsRes, profilesRes] = await Promise.all([
      fetch("https://api.dexscreener.com/token-boosts/top/v1"),
      fetch("https://api.dexscreener.com/token-profiles/latest/v1"),
    ]);
    const boosts = boostsRes.ok ? await boostsRes.json() : [];
    const profiles = profilesRes.ok ? await profilesRes.json() : [];

    const tokenAddrs = [...boosts, ...profiles]
      .filter((t: { chainId?: string }) => t.chainId === "solana")
      .map((t: { tokenAddress: string }) => t.tokenAddress)
      .slice(0, 30);

    if (!tokenAddrs.length) return;

    const detailRes = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${tokenAddrs.join(",")}`);
    if (!detailRes.ok) return;
    const detail = await detailRes.json();

    const pairs = (detail.pairs || []) as { dexId: string; pairAddress: string }[];
    dynamicPairs = pairs
      .filter((p) => p.dexId === "pumpswap" || p.dexId === "meteora")
      .map((p) => p.pairAddress)
      .slice(0, 5);

    console.log(`refreshDynamicPairs: watching ${dynamicPairs.length} trending PumpSwap/Meteora pairs`);
  } catch (e) {
    console.error("refreshDynamicPairs error:", e);
  }
}

refreshDynamicPairs();
setInterval(refreshDynamicPairs, 5 * 60_000);
const DATA_DIR = join(__dirname, "..", "data");
const DISCOVERIES_PATH = join(DATA_DIR, "discoveries.json");
const FILTERS_PATH = join(DATA_DIR, "discovery-filters.json");
const SWAP_LOG_PATH = join(DATA_DIR, "swap-log.json");
const WATCHED_WALLETS_PATH = join(DATA_DIR, "watched-wallets.json");
const WALLET_ACTIVITY_PATH = join(DATA_DIR, "wallet-activity.json");
const FEED_STATE_PATH = join(DATA_DIR, "feed-state.json");
const WALLET_FEED_STATE_PATH = join(DATA_DIR, "wallet-feed-state.json");
const HELIUS_BUDGET_PATH = join(DATA_DIR, "helius-budget.json");
const SCAN_CACHE_PATH = join(DATA_DIR, "scan-cache.json");
const RETENTION_MS = 3 * 24 * 3600 * 1000; // discoveries: keep for at least 3 days
const SWAP_RETENTION_HOURS = 24; // raw swap log: rolling 24h window
const WALLET_ACTIVITY_RETENTION_HOURS = 72; // per-wallet trade notifications: rolling 3 day window
const MAX_WATCHED_WALLETS = 40; // keeps the personal-wallet poller well within Alchemy's free-tier tolerance

const SOLANA_ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

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
let solPriceCache = 80; // overwritten within 2 min by the real price fetch below

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

// Refresh SOL price every 2 min instead of hitting DEX Screener on every swap
setInterval(() => { getSolPrice().then((p) => { solPriceCache = p; }).catch(() => {}); }, 2 * 60_000);
getSolPrice().then((p) => { solPriceCache = p; }).catch(() => {});

// Prune + persist the swap log periodically
setInterval(() => { pruneSwapLog(); saveJson(SWAP_LOG_PATH, swapLog); }, 60_000);
pruneSwapLog();

// Free, credit-free swap collection via public Solana RPC (replaces the Helius webhook)
const feedStats: FeedStats = startSolanaFeed(
  ALCHEMY_RPC_URL,
  () => [...POLL_FEED_SOURCES.map((s) => s.address), ...dynamicPairs],
  (tx) => {
    const swap = extractSwapFromRaw(tx, solPriceCache);
    if (!swap || swap.usd < 20) return;
    swapLog.push({ ts: swap.ts, wallet: swap.wallet, usd: Math.round(swap.usd), side: swap.side });
  },
  FEED_STATE_PATH
);

// ---------- watched wallets (user-starred, from the Wallets page) ----------
//
// A regular trader's own wallet has far lower transaction volume than a
// whole DEX program, so polling it directly via getSignaturesForAddress
// gives genuinely COMPLETE coverage (not "whatever happens to intersect
// with the programs we already watch") — same technique as the trending
// pairs above, just pointed at specific addresses instead.

interface WalletActivityEntry {
  wallet: string;
  mint: string;
  symbol: string;
  side: "buy" | "sell";
  usd: number;
  ts: number;
  detectedAt: number;
}

let watchedWallets: string[] = loadJson<string[]>(WATCHED_WALLETS_PATH, []);
let walletActivity: WalletActivityEntry[] = loadJson<WalletActivityEntry[]>(WALLET_ACTIVITY_PATH, []);

function pruneWalletActivity() {
  const cutoff = Date.now() / 1000 - WALLET_ACTIVITY_RETENTION_HOURS * 3600;
  walletActivity = walletActivity.filter((e) => e.ts >= cutoff);
}

setInterval(() => { pruneWalletActivity(); saveJson(WALLET_ACTIVITY_PATH, walletActivity); }, 60_000);
pruneWalletActivity();

const pendingSymbolLookups: { mint: string; entry: Omit<WalletActivityEntry, "symbol" | "mint"> }[] = [];

async function flushSymbolLookups() {
  if (!pendingSymbolLookups.length) return;
  const batch = pendingSymbolLookups.splice(0, pendingSymbolLookups.length);
  try {
    const symbols = await resolveSymbols(batch.map((b) => b.mint));
    for (const { mint, entry } of batch) {
      walletActivity.unshift({ ...entry, mint, symbol: symbols.get(mint) || mint.slice(0, 6) });
    }
    walletActivity = walletActivity.slice(0, 500);
  } catch {
    for (const { mint, entry } of batch) {
      walletActivity.unshift({ ...entry, mint, symbol: mint.slice(0, 6) });
    }
  }
}
setInterval(flushSymbolLookups, 5_000);

const walletFeedStats: FeedStats = startSolanaFeed(
  ALCHEMY_RPC_URL,
  () => watchedWallets,
  (tx) => {
    const swap = extractSwapFromRaw(tx, solPriceCache);
    if (!swap || swap.usd < 1) return;
    if (!watchedWallets.includes(swap.wallet)) return; // fee payer might differ from the watched address in edge cases
    pendingSymbolLookups.push({
      mint: swap.mint,
      entry: { wallet: swap.wallet, side: swap.side, usd: Math.round(swap.usd), ts: swap.ts, detectedAt: Date.now() },
    });
  },
  WALLET_FEED_STATE_PATH
);

// ---------- discovery scanning ----------

const walletCache = new Map<string, WalletCacheEntry>();

let scanning = false;
let lastScanTs = 0;
let lastScanInfo: Record<string, unknown> | null = null;

// Hard daily ceiling on Helius spend from auto-discovery, independent of
// cron-job.org's own schedule — this is what actually protects the credit
// balance regardless of how often /trigger gets pinged. 2000/day leaves a
// huge margin under the free tier's 1M/month even if every single request
// costs several credits, while still comfortably covering 48 scheduled
// triggers/day at ~30 candidates each (~1440 requests/day worst case).
const DAILY_HELIUS_BUDGET = 2000;
const DISCOVERY_CANDIDATE_LIMIT = 30;

// Persisted across restarts — an in-memory-only counter meant a crash loop
// (or just redeploys) reset the budget to zero each time, quietly defeating
// the cap this exists to enforce.
const savedBudget = loadJson<{ used: number; resetAt: number }>(HELIUS_BUDGET_PATH, { used: 0, resetAt: Date.now() + 24 * 3600 * 1000 });
let heliusRequestsToday = savedBudget.used;
let budgetResetAt = savedBudget.resetAt;

function saveBudget() {
  saveJson(HELIUS_BUDGET_PATH, { used: heliusRequestsToday, resetAt: budgetResetAt });
}

async function runDiscoveryScan(): Promise<{ ok: boolean; newCount: number; totalCount: number; info: unknown }> {
  if (scanning) return { ok: false, newCount: 0, totalCount: 0, info: { error: "already scanning" } };
  if (!HELIUS_API_KEY) return { ok: false, newCount: 0, totalCount: 0, info: { error: "no HELIUS_API_KEY set" } };

  if (Date.now() > budgetResetAt) {
    heliusRequestsToday = 0;
    budgetResetAt = Date.now() + 24 * 3600 * 1000;
    saveBudget();
  }
  if (heliusRequestsToday >= DAILY_HELIUS_BUDGET) {
    return {
      ok: false, newCount: 0, totalCount: 0,
      info: { error: `daily Helius budget (${DAILY_HELIUS_BUDGET}) reached, resets in ${Math.round((budgetResetAt - Date.now()) / 60000)}min` },
    };
  }

  scanning = true;
  try {
    const filters = loadFilters();
    const candidates = getCandidates(filters.maxInactiveHours, 20, DISCOVERY_CANDIDATE_LIMIT);
    const { allAnalyzed, scanInfo } = await runFullScan(HELIUS_API_KEY, candidates, walletCache);
    heliusRequestsToday += scanInfo.heliusRequests;
    saveBudget();

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
    if (url.pathname === "/trigger" && req.method === "GET") {
      if (url.searchParams.get("secret") !== SECRET || !SECRET) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "unauthorized" }));
        return;
      }
      // Emergency circuit breaker: Helius credits ran low unexpectedly, so all
      // Helius-spending work is paused here regardless of what pings this
      // endpoint (cron-job.org keeps firing every 30min either way) until
      // HELIUS_PAUSED is unset.
      if (process.env.HELIUS_PAUSED === "1") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, paused: true, info: { error: "Helius spending paused — see HELIUS_PAUSED in ecosystem.config.cjs" } }));
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
      let next: Partial<ScanFilters>;
      try {
        next = JSON.parse(body);
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "bad json" }));
        return;
      }
      const current = loadFilters();
      // Coerce + clamp every field — a non-numeric value here used to be
      // saved as-is, and NaN comparisons silently reject EVERY wallet, which
      // looks exactly like "scanner stopped finding anything".
      const clamp = (v: unknown, fallback: number, min: number, max: number) => {
        const n = Number(v);
        return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
      };
      const merged: ScanFilters = {
        minWinRate: clamp(next.minWinRate, current.minWinRate, 0, 100),
        minPnlUsd: clamp(next.minPnlUsd, current.minPnlUsd, 0, 10_000_000),
        maxInactiveHours: clamp(next.maxInactiveHours, current.maxInactiveHours, 1, 72),
        minTrades: clamp(next.minTrades, current.minTrades, 1, 100),
      };
      saveJson(FILTERS_PATH, merged);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(merged));
      return;
    }

    // Wallets starred on the /wallets page — synced here so this VM's poller
    // knows which specific addresses to watch.
    if (url.pathname === "/watched-wallets" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ wallets: watchedWallets, limit: MAX_WATCHED_WALLETS }));
      return;
    }

    if (url.pathname === "/watched-wallets" && req.method === "POST") {
      if (url.searchParams.get("secret") !== SECRET || !SECRET) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "unauthorized" }));
        return;
      }
      let body = "";
      for await (const chunk of req) body += chunk;
      let parsed: { address?: string; action?: "add" | "remove" };
      try {
        parsed = JSON.parse(body);
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "bad json" }));
        return;
      }
      const { address, action } = parsed;
      // Strict base58 Solana pubkey shape — garbage entries would waste one
      // of the 40 watch slots AND an RPC poll slot every cycle, forever.
      if (!address || !SOLANA_ADDRESS_RE.test(address)) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "invalid address" }));
        return;
      }
      if (action === "remove") {
        watchedWallets = watchedWallets.filter((w) => w !== address);
      } else {
        if (!watchedWallets.includes(address) && watchedWallets.length < MAX_WATCHED_WALLETS) {
          watchedWallets = [...watchedWallets, address];
        }
      }
      saveJson(WATCHED_WALLETS_PATH, watchedWallets);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ wallets: watchedWallets, limit: MAX_WATCHED_WALLETS }));
      return;
    }

    // Shared cache for the manual Scanner. Vercel's serverless instances each
    // have their own module-level memory, so "cached" results randomly came
    // back empty depending on which instance answered — this VM is the one
    // place all instances can agree on.
    if (url.pathname === "/scan-cache" && req.method === "GET") {
      const cache = loadJson<Record<string, unknown> | null>(SCAN_CACHE_PATH, null);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ cache }));
      return;
    }

    if (url.pathname === "/scan-cache" && req.method === "POST") {
      if (url.searchParams.get("secret") !== SECRET || !SECRET) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "unauthorized" }));
        return;
      }
      let body = "";
      for await (const chunk of req) {
        body += chunk;
        if (body.length > 3_000_000) {
          res.writeHead(413, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "too large" }));
          return;
        }
      }
      try {
        const cache = JSON.parse(body) as { wallets?: unknown[]; ts?: number };
        if (!Array.isArray(cache.wallets) || typeof cache.ts !== "number") throw new Error("bad shape");
        cache.wallets = cache.wallets.slice(0, 150);
        saveJson(SCAN_CACHE_PATH, cache);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "bad json" }));
      }
      return;
    }

    // Recent detected trades on watched wallets — polled by the Wallets page for notifications.
    if (url.pathname === "/wallet-activity" && req.method === "GET") {
      const limit = Number(url.searchParams.get("limit") || "50") || 50;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ activity: walletActivity.slice(0, limit) }));
      return;
    }

    // Full per-wallet trade history without Helius — one page per request,
    // paginated via a signature cursor (?before=), fetched live from Alchemy
    // RPC. No caching: each page is a bounded, self-contained fetch (see
    // walletHistory.ts), cheap enough to just re-run on demand.
    if (url.pathname === "/wallet-history" && req.method === "GET") {
      const wallet = url.searchParams.get("wallet") || "";
      if (!SOLANA_ADDRESS_RE.test(wallet)) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "invalid wallet address" }));
        return;
      }
      const before = url.searchParams.get("before") || undefined;
      const pageSize = Number(url.searchParams.get("limit") || "50") || 50;
      try {
        const page = await fetchWalletHistoryPage(ALCHEMY_RPC_URL, wallet, before, solPriceCache, pageSize);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(page));
      } catch (e) {
        console.error("wallet-history error:", e);
        res.writeHead(502, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "failed to fetch wallet history" }));
      }
      return;
    }

    if (url.pathname === "/health" && req.method === "GET") {
      const oldest = swapLog.length ? Math.round((Date.now() / 1000 - swapLog[0].ts) / 60) : 0;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        ok: true, lastScanTs, scanning, swapLogSize: swapLog.length, oldestSwapMinutesAgo: oldest,
        feed: feedStats, dynamicPairsWatched: dynamicPairs.length,
        walletFeed: walletFeedStats, watchedWalletsCount: watchedWallets.length,
        heliusBudget: { used: heliusRequestsToday, limit: DAILY_HELIUS_BUDGET, resetsInMin: Math.round((budgetResetAt - Date.now()) / 60000) },
      }));
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
  console.log(`swap log loaded: ${swapLog.length} entries`);
});
