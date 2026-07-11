"use client";

import { useState, useEffect, useCallback, useMemo, use } from "react";
import Link from "next/link";
import Navbar from "@/components/Navbar";
import { buildWalletStats, type RawExtractedSwap } from "@/lib/scannerCore";
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Cell,
} from "recharts";

interface PageProps {
  params: Promise<{ address: string }>;
}

type Trade = RawExtractedSwap & { symbol: string };

const GREEN = "#34d399";
const RED = "#f87171";
const SLATE = "#64748b";

function fmt(n: number): string {
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return sign + "$" + (abs / 1_000_000).toFixed(1) + "M";
  if (abs >= 1_000) return sign + "$" + (abs / 1_000).toFixed(1) + "K";
  return sign + "$" + abs.toFixed(abs < 10 ? 2 : 0);
}

function timeAgo(ts: number): string {
  const sec = Math.floor(Date.now() / 1000 - ts);
  if (sec < 60) return sec + "с назад";
  if (sec < 3600) return Math.floor(sec / 60) + "м назад";
  if (sec < 86400) return Math.floor(sec / 3600) + "ч назад";
  return Math.floor(sec / 86400) + "д назад";
}

function dayKey(ts: number): string {
  return new Date(ts * 1000).toISOString().slice(0, 10);
}

export default function WalletHistoryPage({ params }: PageProps) {
  const { address } = use(params);

  const [trades, setTrades] = useState<Trade[]>([]);
  const [nextBefore, setNextBefore] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(true);
  const [rawSeen, setRawSeen] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const loadPage = useCallback(
    async (before: string | undefined, isFirst: boolean) => {
      isFirst ? setLoading(true) : setLoadingMore(true);
      setError(null);
      try {
        const qs = new URLSearchParams({ wallet: address, limit: "50" });
        if (before) qs.set("before", before);
        const r = await fetch(`/api/wallet-history?${qs}`, { cache: "no-store" });
        const d = await r.json();
        if (!r.ok) throw new Error(d.error || "failed");
        setTrades((prev) => [...prev, ...(d.trades || [])]);
        setNextBefore(d.nextBefore ?? null);
        setHasMore(!!d.hasMore);
        setRawSeen((n) => n + (d.rawTxCount || 0));
      } catch {
        setError("Не удалось загрузить историю — сервис сбора данных сейчас недоступен");
      } finally {
        isFirst ? setLoading(false) : setLoadingMore(false);
      }
    },
    [address]
  );

  useEffect(() => {
    loadPage(undefined, true);

    // Record this visit for the search page's "недавно проверенные" list,
    // regardless of whether the user arrived via search or a direct link
    // from Scanner/Wallets/DiscoveriesBell.
    try {
      const RECENT_KEY = "recent_wallet_checks";
      const raw = localStorage.getItem(RECENT_KEY);
      const prev: { address: string; ts: number }[] = raw ? JSON.parse(raw) : [];
      const updated = [{ address, ts: Date.now() / 1000 }, ...prev.filter((r) => r.address !== address)].slice(0, 10);
      localStorage.setItem(RECENT_KEY, JSON.stringify(updated));
    } catch {}
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address]);

  // Every aggregate below is recomputed from whatever's been loaded so far —
  // this is a windowed view (paginated straight from Solana RPC, no Helius),
  // not necessarily this wallet's entire lifetime history.
  const stats = useMemo(() => buildWalletStats(trades), [trades]);

  const symbolByMint = useMemo(() => {
    const m = new Map<string, string>();
    for (const t of trades) m.set(t.mint, t.symbol);
    return m;
  }, [trades]);

  const cumulativePnlSeries = useMemo(() => {
    let running = 0;
    return stats.realizedEvents.map((e) => {
      running += e.pnl;
      return { ts: e.ts, date: new Date(e.ts * 1000).toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit" }), pnl: Math.round(running) };
    });
  }, [stats.realizedEvents]);

  const dailyVolume = useMemo(() => {
    const byDay = new Map<string, { buy: number; sell: number }>();
    for (const t of trades) {
      const k = dayKey(t.ts);
      const cur = byDay.get(k) || { buy: 0, sell: 0 };
      if (t.side === "buy") cur.buy += t.usd; else cur.sell += t.usd;
      byDay.set(k, cur);
    }
    return Array.from(byDay.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([day, v]) => ({ day: day.slice(5), buy: Math.round(v.buy), sell: Math.round(v.sell) }));
  }, [trades]);

  const topPositions = useMemo(() => {
    return [...stats.positionInfos]
      .sort((a, b) => Math.abs(b.pnlUsd) - Math.abs(a.pnlUsd))
      .slice(0, 10)
      .map((p) => ({ ...p, symbol: symbolByMint.get(p.mint) || p.mint.slice(0, 6), label: (symbolByMint.get(p.mint) || p.mint.slice(0, 6)).slice(0, 10) }));
  }, [stats.positionInfos, symbolByMint]);

  const sortedPositions = useMemo(() => {
    return [...stats.positionInfos].sort((a, b) => {
      if (a.status !== b.status) return a.status === "open" ? -1 : 1;
      return Math.abs(b.pnlUsd) - Math.abs(a.pnlUsd);
    });
  }, [stats.positionInfos]);

  function copyAddress() {
    navigator.clipboard?.writeText(address);
    setToast("Адрес скопирован");
    setTimeout(() => setToast(null), 2000);
  }

  const totalTrades = stats.wins + stats.losses;
  const winRate = totalTrades > 0 ? Math.round((stats.wins / totalTrades) * 100) : 0;

  return (
    <div className="min-h-screen">
      <Navbar />

      {toast && (
        <div className="fixed top-16 right-4 z-50 px-4 py-3 rounded-xl text-sm font-medium shadow-xl bg-slate-700 text-white slide-in">
          {toast}
        </div>
      )}

      <main className="max-w-6xl mx-auto px-4 py-6">
        {/* Header */}
        <div className="flex items-center justify-between mb-6 gap-3 flex-wrap">
          <div>
            <Link href="/wallets" className="text-sm text-slate-500 hover:text-slate-300 transition-colors">
              ← Назад к кошелькам
            </Link>
            <div className="flex items-center gap-2 mt-1">
              <h1 className="text-xl font-bold text-white font-mono">
                {address.slice(0, 10)}...{address.slice(-8)}
              </h1>
              <button onClick={copyAddress} className="text-slate-500 hover:text-emerald-400 transition-colors" title="Скопировать">⎘</button>
            </div>
          </div>
          <div className="flex gap-2">
            {[
              { label: "Solscan", href: `https://solscan.io/account/${address}` },
              { label: "Birdeye", href: `https://birdeye.so/profile/${address}?chain=solana` },
              { label: "GMGN", href: `https://gmgn.ai/sol/address/${address}` },
            ].map((l) => (
              <a
                key={l.label}
                href={l.href}
                target="_blank"
                rel="noopener noreferrer"
                className="px-3 py-2 bg-slate-800/50 border border-slate-700 rounded-lg text-xs text-slate-300 hover:border-emerald-500/50 hover:text-emerald-400 transition-colors"
              >
                ↗ {l.label}
              </a>
            ))}
          </div>
        </div>

        <p className="text-xs text-slate-600 mb-5">
          Данные собраны напрямую из блокчейна (без Helius) — учтено {trades.length} сделок из {rawSeen} проверенных транзакций.
          Это окно истории, а не обязательно весь срок жизни кошелька.
        </p>

        {loading ? (
          <div className="flex items-center justify-center py-24">
            <div className="w-8 h-8 border-2 border-slate-700 border-t-emerald-400 rounded-full animate-spin" />
          </div>
        ) : error && !trades.length ? (
          <div className="text-center py-16 text-slate-500">{error}</div>
        ) : !trades.length ? (
          <div className="text-center py-16 text-slate-500">
            Сделок не найдено — либо кошелёк неактивен, либо это не Solana-адрес
          </div>
        ) : (
          <>
            {/* Stats */}
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 mb-6">
              {[
                { label: "Win Rate", value: totalTrades ? winRate + "%" : "—", color: winRate >= 60 ? "text-emerald-400" : "text-slate-300" },
                { label: "PnL (загружено)", value: fmt(stats.totalPnlUsd), color: stats.totalPnlUsd >= 0 ? "text-emerald-400" : "text-red-400" },
                { label: "Закрытых сделок", value: `${totalTrades} (${stats.wins}W/${stats.losses}L)`, color: "text-white" },
                { label: "Открытых позиций", value: stats.openPositions, color: "text-yellow-400" },
                { label: "Объём покупок", value: fmt(stats.totalBuyVolumeUsd), color: "text-slate-300" },
                { label: "Объём продаж", value: fmt(stats.totalSellVolumeUsd), color: "text-slate-300" },
              ].map((s) => (
                <div key={s.label} className="bg-[#0d1117] border border-slate-800 rounded-xl p-3">
                  <div className={`text-lg font-bold ${s.color}`}>{s.value}</div>
                  <div className="text-xs text-slate-500">{s.label}</div>
                </div>
              ))}
            </div>

            {/* Charts */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-6">
              <div className="bg-[#0d1117] border border-slate-800 rounded-xl p-4">
                <div className="text-sm font-medium text-slate-300 mb-3">📈 Накопленный реализованный PnL</div>
                {cumulativePnlSeries.length ? (
                  <ResponsiveContainer width="100%" height={220}>
                    <AreaChart data={cumulativePnlSeries}>
                      <defs>
                        <linearGradient id="pnlGradient" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="0%" stopColor={GREEN} stopOpacity={0.35} />
                          <stop offset="100%" stopColor={GREEN} stopOpacity={0} />
                        </linearGradient>
                      </defs>
                      <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" vertical={false} />
                      <XAxis dataKey="date" stroke={SLATE} fontSize={11} tickLine={false} axisLine={false} />
                      <YAxis stroke={SLATE} fontSize={11} tickLine={false} axisLine={false} tickFormatter={(v) => fmt(v)} width={55} />
                      <Tooltip
                        contentStyle={{ background: "#0d1117", border: "1px solid #1e293b", borderRadius: 8, fontSize: 12 }}
                        labelStyle={{ color: "#94a3b8" }}
                        formatter={(v) => [fmt(Number(v)), "PnL"]}
                      />
                      <Area type="monotone" dataKey="pnl" stroke={GREEN} strokeWidth={2} fill="url(#pnlGradient)" />
                    </AreaChart>
                  </ResponsiveContainer>
                ) : (
                  <div className="h-[220px] flex items-center justify-center text-sm text-slate-600">Нет закрытых сделок в загруженном окне</div>
                )}
              </div>

              <div className="bg-[#0d1117] border border-slate-800 rounded-xl p-4">
                <div className="text-sm font-medium text-slate-300 mb-3">📊 Объём по дням</div>
                <ResponsiveContainer width="100%" height={220}>
                  <BarChart data={dailyVolume}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" vertical={false} />
                    <XAxis dataKey="day" stroke={SLATE} fontSize={11} tickLine={false} axisLine={false} />
                    <YAxis stroke={SLATE} fontSize={11} tickLine={false} axisLine={false} tickFormatter={(v) => fmt(v)} width={55} />
                    <Tooltip
                      contentStyle={{ background: "#0d1117", border: "1px solid #1e293b", borderRadius: 8, fontSize: 12 }}
                      labelStyle={{ color: "#94a3b8" }}
                      formatter={(v, name) => [fmt(Number(v)), name === "buy" ? "Покупки" : "Продажи"]}
                    />
                    <Bar dataKey="buy" fill={GREEN} radius={[3, 3, 0, 0]} />
                    <Bar dataKey="sell" fill={RED} radius={[3, 3, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>

            {/* Per-token PnL breakdown */}
            {topPositions.length > 0 && (
              <div className="bg-[#0d1117] border border-slate-800 rounded-xl p-4 mb-6">
                <div className="text-sm font-medium text-slate-300 mb-3">🪙 PnL по токенам</div>
                <ResponsiveContainer width="100%" height={Math.max(topPositions.length * 32, 100)}>
                  <BarChart data={topPositions} layout="vertical" margin={{ left: 10 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" horizontal={false} />
                    <XAxis type="number" stroke={SLATE} fontSize={11} tickLine={false} axisLine={false} tickFormatter={(v) => fmt(v)} />
                    <YAxis type="category" dataKey="label" stroke={SLATE} fontSize={11} tickLine={false} axisLine={false} width={80} />
                    <Tooltip
                      contentStyle={{ background: "#0d1117", border: "1px solid #1e293b", borderRadius: 8, fontSize: 12 }}
                      labelStyle={{ color: "#94a3b8" }}
                      formatter={(v) => [fmt(Number(v)), "PnL"]}
                    />
                    <Bar dataKey="pnlUsd" radius={[0, 4, 4, 0]}>
                      {topPositions.map((p, i) => (
                        <Cell key={i} fill={p.pnlUsd >= 0 ? GREEN : RED} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}

            {/* Positions */}
            <div className="bg-[#0d1117] border border-slate-800 rounded-xl overflow-hidden mb-6">
              <div className="px-4 py-3 text-sm font-medium text-slate-300 border-b border-slate-800">
                Позиции ({sortedPositions.length})
              </div>
              <div className="divide-y divide-slate-800/50">
                {sortedPositions.map((p) => (
                  <div key={p.mint} className="flex items-center gap-3 px-4 py-3">
                    <span className={`w-7 h-7 rounded-lg flex items-center justify-center text-xs shrink-0 ${
                      p.status === "open" ? "bg-yellow-500/10 text-yellow-400" : p.pnlUsd >= 0 ? "bg-emerald-500/10 text-emerald-400" : "bg-red-500/10 text-red-400"
                    }`}>
                      {p.status === "open" ? "◐" : p.pnlUsd >= 0 ? "✓" : "✕"}
                    </span>
                    <div className="flex-1 min-w-0">
                      <div className="font-semibold text-white text-sm">{symbolByMint.get(p.mint) || p.mint.slice(0, 6)}</div>
                      <div className="text-xs text-slate-500">
                        {p.buyCount} покуп. на {fmt(p.buyUsd)}{p.sellCount ? ` → ${p.sellCount} продаж на ${fmt(p.sellUsd)}` : ""}
                        {p.holdMinutes > 0 && ` · держал ${p.holdMinutes < 60 ? p.holdMinutes + "м" : (p.holdMinutes / 60).toFixed(1) + "ч"}`}
                      </div>
                    </div>
                    <div className="text-right shrink-0">
                      {p.status === "open" ? (
                        <span className="text-xs text-yellow-400">открыта</span>
                      ) : (
                        <>
                          <div className={`text-sm font-bold ${p.pnlUsd >= 0 ? "text-emerald-400" : "text-red-400"}`}>{fmt(p.pnlUsd)}</div>
                          <div className={`text-xs ${p.pnlPct >= 0 ? "text-emerald-400/70" : "text-red-400/70"}`}>{p.pnlPct >= 0 ? "+" : ""}{p.pnlPct.toFixed(1)}%</div>
                        </>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Full transaction table */}
            <div className="bg-[#0d1117] border border-slate-800 rounded-xl overflow-hidden">
              <div className="px-4 py-3 text-sm font-medium text-slate-300 border-b border-slate-800">
                Все транзакции ({trades.length})
              </div>
              <div className="hidden sm:grid grid-cols-[auto_1fr_auto_auto_auto_auto] gap-3 px-4 py-2 text-xs text-slate-500 border-b border-slate-800 font-medium uppercase tracking-wide">
                <span>Тип</span><span>Токен</span><span className="text-right">USD</span>
                <span className="text-right">Кол-во</span><span className="text-right">Время</span><span className="text-right">Tx</span>
              </div>
              <div className="divide-y divide-slate-800/50 max-h-[500px] overflow-y-auto">
                {trades.map((t, i) => (
                  <div key={t.signature + i} className="grid grid-cols-[auto_1fr_auto] sm:grid-cols-[auto_1fr_auto_auto_auto_auto] gap-3 px-4 py-2.5 items-center hover:bg-slate-800/20">
                    <span className={`text-xs font-medium px-1.5 py-0.5 rounded ${t.side === "buy" ? "bg-emerald-500/10 text-emerald-400" : "bg-red-500/10 text-red-400"}`}>
                      {t.side === "buy" ? "КУПИЛ" : "ПРОДАЛ"}
                    </span>
                    <span className="text-sm text-slate-200 truncate">{t.symbol}</span>
                    <span className="text-sm text-slate-300 text-right">{fmt(t.usd)}</span>
                    <span className="hidden sm:block text-xs text-slate-500 text-right">{t.tokens >= 1000 ? (t.tokens / 1000).toFixed(1) + "K" : t.tokens.toFixed(2)}</span>
                    <span className="hidden sm:block text-xs text-slate-500 text-right">{timeAgo(t.ts)}</span>
                    <a
                      href={`https://solscan.io/tx/${t.signature}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="hidden sm:block text-xs text-slate-600 hover:text-emerald-400 text-right transition-colors"
                    >
                      ↗
                    </a>
                  </div>
                ))}
              </div>
            </div>

            {/* Load more */}
            <div className="flex flex-col items-center gap-2 mt-5">
              {error && trades.length > 0 && <div className="text-xs text-red-400">{error}</div>}
              {hasMore ? (
                <button
                  onClick={() => nextBefore && loadPage(nextBefore, false)}
                  disabled={loadingMore}
                  className="px-5 py-2.5 bg-slate-800 hover:bg-slate-700 disabled:opacity-60 text-slate-200 font-medium rounded-xl text-sm transition-colors"
                >
                  {loadingMore ? (
                    <span className="flex items-center gap-2">
                      <span className="w-4 h-4 border-2 border-slate-500 border-t-slate-200 rounded-full animate-spin" />
                      Загружаю более раннюю историю...
                    </span>
                  ) : "Загрузить ещё историю"}
                </button>
              ) : (
                <div className="text-xs text-slate-600">История загружена полностью — это начало активности кошелька</div>
              )}
            </div>
          </>
        )}
      </main>
    </div>
  );
}
