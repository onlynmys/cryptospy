import { NextRequest, NextResponse } from "next/server";
import {
  runFullScan,
  makeFilterFn,
  getDemoWallets,
  DEFAULT_FILTERS,
  type ScanFilters,
  type SmartWallet,
  type WalletCacheEntry,
} from "@/lib/scannerCore";

export const maxDuration = 60;

export type { TokenPositionInfo, SmartWallet, RecentBuy } from "@/lib/scannerCore";

function parseFilters(req: NextRequest): ScanFilters {
  const q = req.nextUrl.searchParams;
  const num = (key: string, fallback: number) => {
    const v = q.get(key);
    if (v === null) return fallback;
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  };
  return {
    minWinRate: num("minWinRate", DEFAULT_FILTERS.minWinRate),
    minPnlUsd: num("minPnl", DEFAULT_FILTERS.minPnlUsd),
    maxInactiveHours: num("maxHours", DEFAULT_FILTERS.maxInactiveHours),
    minTrades: num("minTrades", DEFAULT_FILTERS.minTrades),
  };
}

// ---------- caching (module-level, survives warm Vercel invocations) ----------

const walletCache = new Map<string, WalletCacheEntry>();
let lastGoodScan: { wallets: SmartWallet[]; ts: number; scannedSwaps: number; scannedWallets: number } | null = null;
const SCAN_TTL = 3 * 60 * 1000;

export async function GET(req: NextRequest) {
  const apiKey = process.env.HELIUS_API_KEY;
  const mode = req.nextUrl.searchParams.get("mode");
  const forceRefresh = req.nextUrl.searchParams.get("refresh") === "1";
  const filters = parseFilters(req);

  if (!apiKey) {
    return NextResponse.json({
      wallets: getDemoWallets(),
      real: false,
      hasApiKey: false,
      message: "Добавь Helius API ключ в Settings для реального сканирования",
    });
  }

  // Cached mode: return last scan results WITHOUT touching Helius (0 credits),
  // re-applying whatever filters are currently set in the UI.
  if (mode === "cached") {
    if (lastGoodScan) {
      const passesFilter = makeFilterFn(filters);
      return NextResponse.json({
        wallets: lastGoodScan.wallets.filter(passesFilter),
        real: true,
        hasApiKey: true,
        cached: true,
        scannedSwaps: lastGoodScan.scannedSwaps,
        scannedWallets: lastGoodScan.scannedWallets,
        lastScanTs: lastGoodScan.ts,
      });
    }
    return NextResponse.json({
      wallets: [],
      real: true,
      hasApiKey: true,
      cached: true,
      message: "Нажми «Сканировать» чтобы найти прибыльные кошельки",
    });
  }

  if (!forceRefresh && lastGoodScan && Date.now() - lastGoodScan.ts < SCAN_TTL) {
    const passesFilter = makeFilterFn(filters);
    return NextResponse.json({
      wallets: lastGoodScan.wallets.filter(passesFilter),
      real: true,
      hasApiKey: true,
      cached: true,
      scannedSwaps: lastGoodScan.scannedSwaps,
      scannedWallets: lastGoodScan.scannedWallets,
    });
  }

  const discoveryBase = process.env.DISCOVERY_SERVER_URL;
  if (!discoveryBase) {
    return respondWithFallback(
      "Сервис сбора кандидатов не настроен (DISCOVERY_SERVER_URL). Обратись к администратору.",
      filters
    );
  }

  try {
    // Candidates come from our VM's continuously-collected (webhook-fed) swap
    // log, not from an on-demand network pull — pulling history for busy DEX
    // programs on demand only ever covers a few seconds, not hours. See
    // scripts/discovery-server.ts for why.
    let candidates: string[] = [];
    try {
      const cr = await fetch(`${discoveryBase}/candidates?hours=${filters.maxInactiveHours}`, {
        signal: AbortSignal.timeout(8000),
        cache: "no-store",
      });
      if (cr.ok) {
        const cd = await cr.json();
        candidates = cd.candidates || [];
      }
    } catch {
      // handled by empty candidates fallback below
    }

    if (!candidates.length) {
      return respondWithFallback(
        "Сервис сбора кандидатов пока не накопил данных за это окно — подожди немного или расширь окно активности.",
        filters
      );
    }

    const { allAnalyzed: results, scanInfo } = await runFullScan(apiKey, candidates, walletCache);

    if (!results.length && !lastGoodScan) {
      return respondWithFallback("Ни один из найденных кандидатов не набрал закрытых сделок — попробуй позже", filters);
    }

    // Merge newly analyzed wallets with everything kept from previous scans
    // (unfiltered — filters are applied afterward so the UI can adjust them freely
    // without re-spending Helius credits).
    const merged = new Map<string, SmartWallet>();
    if (lastGoodScan) {
      for (const w of lastGoodScan.wallets) merged.set(w.address, w);
    }
    for (const w of results) merged.set(w.address, w);

    // Drop wallets that are too stale to matter regardless of filter settings
    const STALE_CUTOFF = Date.now() / 1000 - 72 * 3600;
    const allAnalyzed = Array.from(merged.values())
      .filter((w) => w.lastActivity >= STALE_CUTOFF)
      .sort((a, b) => b.score - a.score)
      .slice(0, 150);

    lastGoodScan = {
      wallets: allAnalyzed,
      ts: Date.now(),
      scannedSwaps: candidates.length,
      scannedWallets: scanInfo.scannedWallets,
    };

    const passesFilter = makeFilterFn(filters);
    const finalList = allAnalyzed.filter(passesFilter);

    const responseInfo = {
      scannedSwaps: candidates.length,
      scannedWallets: scanInfo.scannedWallets,
      passedFilter: finalList.length,
      analyzedTotal: allAnalyzed.length,
      rejected: scanInfo.rejected,
      heliusRequests: scanInfo.heliusRequests,
      durationSec: scanInfo.durationSec,
    };

    if (!finalList.length) {
      return NextResponse.json({
        wallets: [],
        real: true,
        hasApiKey: true,
        ...responseInfo,
        message: `Проверено ${scanInfo.scannedWallets} трейдеров из ${candidates.length} кандидатов — ни один не прошёл текущий фильтр. Попробуй ослабить фильтры или сканируй в разное время.`,
      });
    }

    return NextResponse.json({
      wallets: finalList,
      real: true,
      hasApiKey: true,
      ...responseInfo,
    });
  } catch (e) {
    console.error("Scanner error:", e);
    return respondWithFallback("Ошибка сканирования — показаны последние результаты", filters);
  }
}

function respondWithFallback(message: string, filters: ScanFilters = DEFAULT_FILTERS) {
  if (lastGoodScan && lastGoodScan.wallets.length) {
    const passesFilter = makeFilterFn(filters);
    return NextResponse.json({
      wallets: lastGoodScan.wallets.filter(passesFilter),
      real: true,
      hasApiKey: true,
      cached: true,
      message,
      scannedSwaps: lastGoodScan.scannedSwaps,
      scannedWallets: lastGoodScan.scannedWallets,
    });
  }
  return NextResponse.json({ wallets: [], real: true, hasApiKey: true, message });
}
