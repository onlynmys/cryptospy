"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import Navbar from "@/components/Navbar";
import SmartWalletRow, { fmtUsd } from "@/components/SmartWalletRow";
import type { SmartWallet } from "@/lib/scannerCore";

interface ScanMeta {
  real: boolean;
  hasApiKey: boolean;
  message?: string;
  cached?: boolean;
  scannedSwaps?: number;
  scannedWallets?: number;
  passedFilter?: number;
  rejected?: number;
  heliusRequests?: number;
  durationSec?: number;
  lastScanTs?: number;
}

interface ScanFilters {
  minWinRate: number;
  minPnl: number;
  maxHours: number;
  minTrades: number;
}

const DEFAULT_FILTERS: ScanFilters = { minWinRate: 60, minPnl: 800, maxHours: 6, minTrades: 1 };

function filtersToQuery(f: ScanFilters): string {
  return `minWinRate=${f.minWinRate}&minPnl=${f.minPnl}&maxHours=${f.maxHours}&minTrades=${f.minTrades}`;
}

export default function ScannerPage() {
  const [wallets, setWallets] = useState<SmartWallet[]>([]);
  const [loading, setLoading] = useState(false);
  const [meta, setMeta] = useState<ScanMeta | null>(null);
  const [lastScan, setLastScan] = useState<Date | null>(null);
  const [copied, setCopied] = useState(false);
  const [sortBy, setSortBy] = useState<"score" | "winRate" | "pnl">("score");
  const [filterTag, setFilterTag] = useState("");
  const [page, setPage] = useState(1);
  const [filters, setFilters] = useState<ScanFilters>(DEFAULT_FILTERS);
  const [showFilters, setShowFilters] = useState(false);
  const PER_PAGE = 10;

  // Load saved filter settings once
  useEffect(() => {
    try {
      const saved = localStorage.getItem("scanner_filters");
      if (saved) setFilters({ ...DEFAULT_FILTERS, ...JSON.parse(saved) });
    } catch { /* ignore */ }
  }, []);

  function updateFilters(next: ScanFilters) {
    setFilters(next);
    localStorage.setItem("scanner_filters", JSON.stringify(next));
  }

  // Manual scan — the only thing that spends Helius credits
  const scan = useCallback(async (f: ScanFilters) => {
    setLoading(true);
    try {
      const r = await fetch(`/api/scanner?refresh=1&${filtersToQuery(f)}`);
      const d = await r.json();
      setWallets(d.wallets || []);
      setMeta(d);
      setLastScan(new Date());
      setPage(1);
    } finally {
      setLoading(false);
    }
  }, []);

  // Re-apply filters against the cached (already analyzed) wallet pool — zero Helius cost
  const applyFiltersFromCache = useCallback(async (f: ScanFilters) => {
    try {
      const r = await fetch(`/api/scanner?mode=cached&${filtersToQuery(f)}`);
      const d = await r.json();
      setWallets(d.wallets || []);
      setMeta(d);
      if (d.lastScanTs) setLastScan(new Date(d.lastScanTs));
      setPage(1);
    } catch { /* ignore */ }
  }, []);

  // On page load: show cached results only, zero Helius requests
  useEffect(() => {
    (async () => {
      try {
        const saved = localStorage.getItem("scanner_filters");
        const f: ScanFilters = saved ? { ...DEFAULT_FILTERS, ...JSON.parse(saved) } : DEFAULT_FILTERS;
        const r = await fetch(`/api/scanner?mode=cached&${filtersToQuery(f)}`);
        const d = await r.json();
        setWallets(d.wallets || []);
        setMeta(d);
        if (d.lastScanTs) setLastScan(new Date(d.lastScanTs));
      } catch { /* ignore */ }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function copyAddr(addr: string) {
    navigator.clipboard?.writeText(addr);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  const allTags = Array.from(new Set(wallets.flatMap((w) => w.tags)));

  const filtered = wallets
    .filter((w) => !filterTag || w.tags.includes(filterTag))
    .sort((a, b) => {
      if (sortBy === "winRate") return b.winRate - a.winRate;
      if (sortBy === "pnl") return b.totalPnlUsd - a.totalPnlUsd;
      return b.score - a.score;
    });

  const totalPages = Math.max(1, Math.ceil(filtered.length / PER_PAGE));
  const safePage = Math.min(page, totalPages);
  const displayed = filtered.slice((safePage - 1) * PER_PAGE, safePage * PER_PAGE);

  return (
    <div className="min-h-screen">
      <Navbar />

      {copied && (
        <div className="fixed top-16 right-4 z-50 bg-emerald-500 text-black px-4 py-2 rounded-xl text-sm font-medium slide-in">
          ✓ Адрес скопирован
        </div>
      )}

      <main className="max-w-5xl mx-auto px-4 py-6">
        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-4 mb-6">
          <div>
            <h1 className="text-2xl font-bold text-white flex items-center gap-2">🧠 Smart Money Scanner</h1>
            <p className="text-slate-500 text-sm mt-1">
              Win Rate ≥ {filters.minWinRate}% · PnL ≥ ${filters.minPnl} · активность {filters.maxHours}ч · сделок ≥ {filters.minTrades}
            </p>
            {lastScan && (
              <p className="text-slate-600 text-xs mt-1">
                Последний скан: {lastScan.toLocaleTimeString()}
              </p>
            )}
          </div>

          <div className="flex items-center gap-2 shrink-0">
            {meta && (
              <span className={`text-xs px-2 py-1 rounded-full font-medium flex items-center gap-1.5 ${
                meta.real ? "bg-emerald-500/10 text-emerald-400 border border-emerald-500/20" : "bg-slate-800 text-slate-500"
              }`}>
                <span className={`w-1.5 h-1.5 rounded-full ${meta.real ? "bg-emerald-400" : "bg-slate-600"}`} />
                {meta.real ? "On-chain данные" : "Демо режим"}
              </span>
            )}
            <button
              onClick={() => setShowFilters(!showFilters)}
              className={`px-3 py-2 rounded-xl text-sm font-medium transition-all border ${
                showFilters ? "bg-slate-700 text-white border-slate-600" : "border-slate-700 text-slate-400 hover:text-white"
              }`}
            >
              ⚙ Фильтры
            </button>
            <button
              onClick={() => scan(filters)}
              disabled={loading}
              className="px-4 py-2 bg-emerald-500 hover:bg-emerald-400 disabled:opacity-50 text-black font-semibold rounded-xl text-sm transition-all flex items-center gap-2"
            >
              {loading ? (
                <><span className="w-4 h-4 border-2 border-black/30 border-t-black rounded-full animate-spin" />Сканирую...</>
              ) : (<>🔍 Сканировать</>)}
            </button>
          </div>
        </div>

        {/* Filter settings panel */}
        {showFilters && (
          <div className="bg-[#0d1117] border border-slate-700 rounded-xl p-4 mb-5">
            <div className="text-sm font-medium text-slate-300 mb-3">Настройки фильтра</div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
              <div>
                <label className="text-xs text-slate-500 block mb-1.5">Мин. Win Rate</label>
                <div className="flex items-center gap-2">
                  <input
                    type="number" min={0} max={100} step={5}
                    value={filters.minWinRate}
                    onChange={(e) => updateFilters({ ...filters, minWinRate: Number(e.target.value) })}
                    className="w-full bg-slate-800 border border-slate-700 rounded-lg px-2 py-1.5 text-sm text-white focus:outline-none focus:border-emerald-500"
                  />
                  <span className="text-xs text-slate-500 shrink-0">%</span>
                </div>
              </div>
              <div>
                <label className="text-xs text-slate-500 block mb-1.5">Мин. PnL</label>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-slate-500 shrink-0">$</span>
                  <input
                    type="number" min={0} step={100}
                    value={filters.minPnl}
                    onChange={(e) => updateFilters({ ...filters, minPnl: Number(e.target.value) })}
                    className="w-full bg-slate-800 border border-slate-700 rounded-lg px-2 py-1.5 text-sm text-white focus:outline-none focus:border-emerald-500"
                  />
                </div>
              </div>
              <div>
                <label className="text-xs text-slate-500 block mb-1.5">Активность за</label>
                <div className="flex items-center gap-2">
                  <input
                    type="number" min={1} max={168} step={1}
                    value={filters.maxHours}
                    onChange={(e) => updateFilters({ ...filters, maxHours: Number(e.target.value) })}
                    className="w-full bg-slate-800 border border-slate-700 rounded-lg px-2 py-1.5 text-sm text-white focus:outline-none focus:border-emerald-500"
                  />
                  <span className="text-xs text-slate-500 shrink-0">ч</span>
                </div>
              </div>
              <div>
                <label className="text-xs text-slate-500 block mb-1.5">Мин. сделок</label>
                <input
                  type="number" min={1} step={1}
                  value={filters.minTrades}
                  onChange={(e) => updateFilters({ ...filters, minTrades: Number(e.target.value) })}
                  className="w-full bg-slate-800 border border-slate-700 rounded-lg px-2 py-1.5 text-sm text-white focus:outline-none focus:border-emerald-500"
                />
              </div>
            </div>

            <div className="flex items-center gap-2 mt-3 flex-wrap">
              <span className="text-xs text-slate-600">Пресеты:</span>
              {[
                { label: "Строгий", f: { minWinRate: 70, minPnl: 2000, maxHours: 24, minTrades: 3 } },
                { label: "Стандарт", f: DEFAULT_FILTERS },
                { label: "Мягкий", f: { minWinRate: 50, minPnl: 100, maxHours: 48, minTrades: 1 } },
                { label: "Только сегодня", f: { minWinRate: 55, minPnl: 300, maxHours: 6, minTrades: 1 } },
              ].map((p) => (
                <button
                  key={p.label}
                  onClick={() => updateFilters(p.f)}
                  className="text-xs px-2.5 py-1 rounded-lg border border-slate-700 text-slate-400 hover:text-white hover:border-slate-500 transition-colors"
                >
                  {p.label}
                </button>
              ))}
              <button
                onClick={() => applyFiltersFromCache(filters)}
                className="ml-auto text-xs px-3 py-1.5 rounded-lg bg-slate-800 text-emerald-400 hover:bg-slate-700 transition-colors font-medium"
              >
                ↻ Применить к текущим данным (бесплатно)
              </button>
            </div>
          </div>
        )}

        {/* Scan report */}
        {meta && !meta.cached && meta.heliusRequests !== undefined && (
          <div className="bg-[#0d1117] border border-slate-800 rounded-xl p-3 mb-4">
            <div className="text-xs text-slate-500 font-medium uppercase tracking-wide mb-2">Отчёт сканирования</div>
            <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 text-sm">
              <div><span className="text-slate-500">Кандидатов из лога: </span><span className="text-white font-semibold">{meta.scannedSwaps}</span></div>
              <div><span className="text-slate-500">Трейдеров проверено: </span><span className="text-white font-semibold">{meta.scannedWallets}</span></div>
              <div><span className="text-slate-500">Прошли фильтр: </span><span className="text-emerald-400 font-semibold">{meta.passedFilter}</span></div>
              <div><span className="text-slate-500">Запросов Helius: </span><span className="text-yellow-400 font-semibold">{meta.heliusRequests}</span></div>
              <div><span className="text-slate-500">Время: </span><span className="text-white font-semibold">{meta.durationSec}с</span></div>
            </div>
          </div>
        )}

        {/* Message from API */}
        {meta?.message && meta.hasApiKey && (
          <div className="bg-yellow-500/5 border border-yellow-500/20 rounded-xl px-4 py-3 mb-4 text-sm text-yellow-200/80">
            {meta.message}
          </div>
        )}

        {/* No API key banner */}
        {meta && !meta.hasApiKey && (
          <div className="bg-blue-500/10 border border-blue-500/20 rounded-xl p-4 mb-6 flex flex-col sm:flex-row items-start sm:items-center gap-3">
            <div className="text-2xl shrink-0">🔑</div>
            <div className="flex-1">
              <div className="text-white font-medium">Подключи Helius API для реального сканирования</div>
              <div className="text-slate-400 text-sm mt-0.5">
                Сейчас демо-данные. Helius бесплатный — 1M запросов/месяц.
              </div>
            </div>
            <div className="flex gap-2 shrink-0">
              <a href="https://helius.dev" target="_blank" rel="noopener noreferrer"
                className="px-3 py-1.5 bg-blue-500 text-white text-sm font-medium rounded-lg hover:bg-blue-400 transition-colors">
                Получить ключ →
              </a>
              <Link href="/settings" className="px-3 py-1.5 border border-slate-700 text-slate-300 text-sm rounded-lg hover:border-slate-500 transition-colors">
                Настройки
              </Link>
            </div>
          </div>
        )}

        {/* Stats */}
        {wallets.length > 0 && (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-5">
            {[
              { label: "Найдено кошельков", value: wallets.length.toString(), color: "text-white" },
              { label: "Win Rate ≥ 70%", value: wallets.filter((w) => w.winRate >= 70).length.toString(), color: "text-emerald-400" },
              { label: "Суммарный PnL", value: fmtUsd(wallets.reduce((s, w) => s + w.totalPnlUsd, 0), true), color: "text-emerald-400" },
              { label: "Ср. Win Rate", value: Math.round(wallets.reduce((s, w) => s + w.winRate, 0) / wallets.length) + "%", color: "text-blue-400" },
            ].map((s) => (
              <div key={s.label} className="bg-[#0d1117] border border-slate-800 rounded-xl p-3">
                <div className={`text-xl font-bold ${s.color}`}>{s.value}</div>
                <div className="text-xs text-slate-500">{s.label}</div>
              </div>
            ))}
          </div>
        )}

        {/* Filters */}
        {wallets.length > 0 && (
          <div className="flex flex-col sm:flex-row gap-3 mb-4">
            <div className="flex gap-1 flex-wrap">
              <button onClick={() => { setFilterTag(""); setPage(1); }}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all border ${!filterTag ? "bg-slate-700 text-white border-slate-600" : "text-slate-500 border-slate-800 hover:text-slate-300"}`}>
                Все
              </button>
              {allTags.map((t) => (
                <button key={t} onClick={() => { setFilterTag(filterTag === t ? "" : t); setPage(1); }}
                  className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all border ${filterTag === t ? "bg-slate-700 text-white border-slate-600" : "text-slate-500 border-slate-800 hover:text-slate-300"}`}>
                  {t}
                </button>
              ))}
            </div>
            <div className="flex items-center gap-2 sm:ml-auto text-sm text-slate-500">
              <span>Сорт:</span>
              {(["score", "winRate", "pnl"] as const).map((s) => (
                <button key={s} onClick={() => setSortBy(s)}
                  className={`px-2 py-1 rounded transition-colors ${sortBy === s ? "text-emerald-400" : "hover:text-slate-300"}`}>
                  {s === "winRate" ? "Win %" : s === "pnl" ? "PnL" : "Score"}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* List */}
        {loading && wallets.length === 0 ? (
          <div className="space-y-3">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="border border-slate-800 rounded-xl p-4 animate-pulse">
                <div className="flex gap-3 items-center">
                  <div className="w-10 h-10 bg-slate-800 rounded-lg" />
                  <div className="flex-1">
                    <div className="h-4 bg-slate-800 rounded w-48 mb-2" />
                    <div className="h-3 bg-slate-800 rounded w-32" />
                  </div>
                  <div className="flex gap-4">
                    {[0, 1, 2].map((j) => <div key={j} className="w-16 h-8 bg-slate-800 rounded" />)}
                  </div>
                </div>
              </div>
            ))}
            <div className="text-center text-slate-500 text-sm py-2">
              Сканирую активные пары и анализирую кошельки... (~20-40 сек)
            </div>
          </div>
        ) : displayed.length === 0 ? (
          <div className="text-center py-20 text-slate-500">Нет кошельков по фильтру</div>
        ) : (
          <>
            <div className="space-y-2">
              {displayed.map((w) => (
                <SmartWalletRow key={w.address} wallet={w} onCopy={copyAddr} />
              ))}
            </div>

            {/* Pagination */}
            {totalPages > 1 && (
              <div className="flex items-center justify-center gap-2 mt-6">
                <button
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  disabled={safePage === 1}
                  className="px-3 py-1.5 border border-slate-700 text-slate-400 hover:text-white disabled:opacity-40 disabled:cursor-not-allowed rounded-lg text-sm transition-colors"
                >
                  ← Назад
                </button>
                {Array.from({ length: totalPages }, (_, i) => i + 1).map((p) => (
                  <button
                    key={p}
                    onClick={() => setPage(p)}
                    className={`w-9 h-9 rounded-lg text-sm font-medium transition-all ${
                      p === safePage
                        ? "bg-emerald-500 text-black"
                        : "border border-slate-800 text-slate-500 hover:text-white hover:border-slate-600"
                    }`}
                  >
                    {p}
                  </button>
                ))}
                <button
                  onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                  disabled={safePage === totalPages}
                  className="px-3 py-1.5 border border-slate-700 text-slate-400 hover:text-white disabled:opacity-40 disabled:cursor-not-allowed rounded-lg text-sm transition-colors"
                >
                  Вперёд →
                </button>
              </div>
            )}
            <div className="text-center text-xs text-slate-600 mt-2">
              {filtered.length} кошельков · страница {safePage} из {totalPages}
            </div>
          </>
        )}

        <p className="text-xs text-slate-600 text-center mt-6">
          Нажми на кошелёк для детальной статистики · Сканирование запускается только вручную (~30-35 запросов Helius за скан)
        </p>
      </main>
    </div>
  );
}
