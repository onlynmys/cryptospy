"use client";

import { useState, useEffect, useCallback, useMemo, useRef, use } from "react";
import Link from "next/link";
import Navbar from "@/components/Navbar";
import { buildWalletStats, type TimedSwap } from "@/lib/scannerCore";
import type { WalletEvent, WalletEventType } from "@/scripts/walletHistory";
import { PnlLineChart, VolumeBars, TokenPnlBars, fmtUsd } from "@/components/walletCharts";

interface PageProps {
  params: Promise<{ address: string }>;
}

function timeAgo(ts: number): string {
  const sec = Math.floor(Date.now() / 1000 - ts);
  if (sec < 60) return sec + "с назад";
  if (sec < 3600) return Math.floor(sec / 60) + "м назад";
  if (sec < 86400) return Math.floor(sec / 3600) + "ч назад";
  return Math.floor(sec / 86400) + "д назад";
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000_000) return (n / 1_000_000_000).toFixed(1) + "B";
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "K";
  return n >= 100 ? n.toFixed(0) : n.toFixed(2);
}

function shortAddr(a: string): string {
  return a.slice(0, 6) + "..." + a.slice(-4);
}

const EVENT_META: Record<WalletEventType, { label: string; badge: string; cls: string }> = {
  buy: { label: "Покупка", badge: "КУПИЛ", cls: "bg-emerald-500/15 text-emerald-400" },
  sell: { label: "Продажа", badge: "ПРОДАЛ", cls: "bg-red-500/15 text-red-400" },
  token_in: { label: "Получение токенов", badge: "ПОЛУЧИЛ", cls: "bg-sky-500/15 text-sky-400" },
  token_out: { label: "Отправка токенов", badge: "ОТПРАВИЛ", cls: "bg-orange-500/15 text-orange-400" },
  sol_in: { label: "Получение SOL", badge: "SOL ⬇", cls: "bg-cyan-500/15 text-cyan-300" },
  sol_out: { label: "Отправка SOL", badge: "SOL ⬆", cls: "bg-amber-500/15 text-amber-300" },
};

type FilterTab = "all" | "trades" | "transfers" | "sol";
const FILTER_TABS: { id: FilterTab; label: string }[] = [
  { id: "all", label: "Все" },
  { id: "trades", label: "Сделки" },
  { id: "transfers", label: "Переводы токенов" },
  { id: "sol", label: "Переводы SOL" },
];

function matchesTab(e: WalletEvent, tab: FilterTab): boolean {
  if (tab === "all") return true;
  if (tab === "trades") return e.type === "buy" || e.type === "sell";
  if (tab === "transfers") return e.type === "token_in" || e.type === "token_out";
  return e.type === "sol_in" || e.type === "sol_out";
}

export default function WalletHistoryPage({ params }: PageProps) {
  const { address } = use(params);

  const [events, setEvents] = useState<WalletEvent[]>([]);
  const [nextBefore, setNextBefore] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(true);
  const [rawSeen, setRawSeen] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [tab, setTab] = useState<FilterTab>("all");
  const [loadAmount, setLoadAmount] = useState(100);
  const [progress, setProgress] = useState<{ done: number; target: number } | null>(null);
  const cancelRef = useRef(false);

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
        setEvents((prev) => [...prev, ...(d.events || [])]);
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

  // The server caps one request at 100 transactions (Alchemy free-tier
  // pacing + Vercel's proxy timeout), so bigger depths are fetched as a
  // client-side chain of ≤100-tx pages behind one button, with live
  // progress and a working Stop.
  const loadMoreSmart = useCallback(async () => {
    if (!nextBefore || loadingMore) return;
    cancelRef.current = false;
    setLoadingMore(true);
    setError(null);
    const target = loadAmount;
    let cursor: string | null = nextBefore;
    let fetched = 0;
    setProgress({ done: 0, target });
    try {
      while (cursor && fetched < target && !cancelRef.current) {
        const chunk = Math.min(100, target - fetched);
        const qs = new URLSearchParams({ wallet: address, limit: String(chunk), before: cursor });
        const r = await fetch(`/api/wallet-history?${qs}`, { cache: "no-store" });
        const d: { events?: WalletEvent[]; nextBefore?: string | null; hasMore?: boolean; rawTxCount?: number; error?: string } = await r.json();
        if (!r.ok) throw new Error(d.error || "failed");
        setEvents((prev) => [...prev, ...(d.events || [])]);
        setRawSeen((n) => n + (d.rawTxCount || 0));
        cursor = d.nextBefore ?? null;
        setNextBefore(cursor);
        setHasMore(!!d.hasMore && !!cursor);
        if (!d.hasMore) break;
        if (!d.rawTxCount) break; // page yielded nothing — don't spin forever
        fetched += d.rawTxCount;
        setProgress({ done: Math.min(fetched, target), target });
      }
    } catch {
      setError("Не удалось загрузить историю — сервис сбора данных сейчас недоступен");
    } finally {
      setLoadingMore(false);
      setProgress(null);
    }
  }, [address, nextBefore, loadingMore, loadAmount]);

  useEffect(() => {
    loadPage(undefined, true);

    // Record this visit for the search page's "недавно проверенные" list,
    // regardless of whether the user arrived via search or a direct link.
    try {
      const RECENT_KEY = "recent_wallet_checks";
      const raw = localStorage.getItem(RECENT_KEY);
      const prev: { address: string; ts: number }[] = raw ? JSON.parse(raw) : [];
      const updated = [{ address, ts: Date.now() / 1000 }, ...prev.filter((r) => r.address !== address)].slice(0, 10);
      localStorage.setItem(RECENT_KEY, JSON.stringify(updated));
    } catch {}
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address]);

  // ---------- derived analytics (recomputed as more pages load) ----------

  const swaps = useMemo<TimedSwap[]>(
    () =>
      events
        .filter((e) => (e.type === "buy" || e.type === "sell") && e.mint && e.usd !== null)
        .map((e) => ({ mint: e.mint!, usd: e.usd!, tokens: e.tokens || 0, side: e.type as "buy" | "sell", ts: e.ts })),
    [events]
  );

  const stats = useMemo(() => buildWalletStats(swaps), [swaps]);

  const symbolByMint = useMemo(() => {
    const m = new Map<string, string>();
    for (const e of events) if (e.mint && e.symbol) m.set(e.mint, e.symbol);
    return m;
  }, [events]);

  const pnlSeries = useMemo(() => {
    let running = 0;
    return stats.realizedEvents.map((e) => {
      running += e.pnl;
      return { ts: e.ts, value: Math.round(running) };
    });
  }, [stats.realizedEvents]);

  const dailyVolume = useMemo(() => {
    const byDay = new Map<string, { buy: number; sell: number }>();
    for (const s of swaps) {
      const k = new Date(s.ts * 1000).toISOString().slice(0, 10);
      const cur = byDay.get(k) || { buy: 0, sell: 0 };
      if (s.side === "buy") cur.buy += s.usd; else cur.sell += s.usd;
      byDay.set(k, cur);
    }
    return Array.from(byDay.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([day, v]) => ({ day: day.slice(5).replace("-", "."), buy: Math.round(v.buy), sell: Math.round(v.sell) }));
  }, [swaps]);

  const tokenPnlRows = useMemo(
    () =>
      [...stats.positionInfos]
        .filter((p) => p.sellCount > 0)
        .sort((a, b) => Math.abs(b.pnlUsd) - Math.abs(a.pnlUsd))
        .slice(0, 12)
        .map((p) => ({ label: symbolByMint.get(p.mint) || p.mint.slice(0, 6), value: p.pnlUsd })),
    [stats.positionInfos, symbolByMint]
  );

  // Per-mint transfer totals — shown inside position rows so "sold more than
  // bought" cases visibly trace back to tokens that arrived by transfer.
  const transfersByMint = useMemo(() => {
    const m = new Map<string, { inTok: number; outTok: number }>();
    for (const e of events) {
      if ((e.type !== "token_in" && e.type !== "token_out") || !e.mint) continue;
      const cur = m.get(e.mint) || { inTok: 0, outTok: 0 };
      if (e.type === "token_in") cur.inTok += e.tokens || 0; else cur.outTok += e.tokens || 0;
      m.set(e.mint, cur);
    }
    return m;
  }, [events]);

  const counterparties = useMemo(() => {
    const m = new Map<string, { inUsd: number; outUsd: number; count: number; lastTs: number }>();
    for (const e of events) {
      if (!e.counterparty) continue;
      const cur = m.get(e.counterparty) || { inUsd: 0, outUsd: 0, count: 0, lastTs: 0 };
      const usd = e.usd ?? 0;
      if (e.type === "token_in" || e.type === "sol_in") cur.inUsd += usd;
      else cur.outUsd += usd;
      cur.count++;
      cur.lastTs = Math.max(cur.lastTs, e.ts);
      m.set(e.counterparty, cur);
    }
    return Array.from(m.entries())
      .sort((a, b) => (b[1].inUsd + b[1].outUsd) - (a[1].inUsd + a[1].outUsd))
      .slice(0, 8);
  }, [events]);

  const flows = useMemo(() => {
    let solIn = 0, solOut = 0, feeSol = 0, transfersInUsd = 0, transfersOutUsd = 0;
    for (const e of events) {
      if (e.feeSol) feeSol += e.feeSol;
      if (e.type === "sol_in") solIn += e.sol || 0;
      if (e.type === "sol_out") solOut += e.sol || 0;
      if (e.type === "token_in") transfersInUsd += e.usd ?? 0;
      if (e.type === "token_out") transfersOutUsd += e.usd ?? 0;
    }
    return { solIn, solOut, feeSol, transfersInUsd, transfersOutUsd };
  }, [events]);

  const sortedPositions = useMemo(
    () =>
      [...stats.positionInfos].sort((a, b) => {
        if (a.status !== b.status) return a.status === "open" ? -1 : 1;
        return Math.abs(b.pnlUsd) - Math.abs(a.pnlUsd);
      }),
    [stats.positionInfos]
  );

  const filteredEvents = useMemo(() => events.filter((e) => matchesTab(e, tab)), [events, tab]);
  const tabCounts = useMemo(() => {
    const c: Record<FilterTab, number> = { all: events.length, trades: 0, transfers: 0, sol: 0 };
    for (const e of events) {
      if (e.type === "buy" || e.type === "sell") c.trades++;
      else if (e.type === "token_in" || e.type === "token_out") c.transfers++;
      else c.sol++;
    }
    return c;
  }, [events]);

  function copyAddress(a: string = address) {
    navigator.clipboard?.writeText(a);
    setToast("Адрес скопирован");
    setTimeout(() => setToast(null), 2000);
  }

  const totalTrades = stats.wins + stats.losses;
  const winRate = totalTrades > 0 ? Math.round((stats.wins / totalTrades) * 100) : 0;
  const oldestTs = events.length ? events[events.length - 1].ts : null;

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
        <div className="flex items-center justify-between mb-4 gap-3 flex-wrap">
          <div>
            <Link href="/wallet" className="text-sm text-slate-500 hover:text-slate-300 transition-colors">
              ← Проверить другой кошелёк
            </Link>
            <div className="flex items-center gap-2 mt-1">
              <h1 className="text-xl font-bold text-white font-mono break-all">
                {address.slice(0, 10)}...{address.slice(-8)}
              </h1>
              <button onClick={() => copyAddress()} className="text-slate-500 hover:text-emerald-400 transition-colors" title="Скопировать">⎘</button>
            </div>
          </div>
          <div className="flex gap-2">
            {[
              { label: "Solscan", href: `https://solscan.io/account/${address}` },
              { label: "Birdeye", href: `https://birdeye.so/profile/${address}?chain=solana` },
              { label: "GMGN", href: `https://gmgn.ai/sol/address/${address}` },
            ].map((l) => (
              <a key={l.label} href={l.href} target="_blank" rel="noopener noreferrer"
                className="px-3 py-2 bg-slate-800/50 border border-slate-700 rounded-lg text-xs text-slate-300 hover:border-emerald-500/50 hover:text-emerald-400 transition-colors">
                ↗ {l.label}
              </a>
            ))}
          </div>
        </div>

        <p className="text-xs text-slate-600 mb-5">
          Прочитано напрямую из блокчейна: {events.length} событий из {rawSeen} транзакций
          {oldestTs ? `, окно с ${new Date(oldestTs * 1000).toLocaleDateString("ru-RU")} по сейчас` : ""}.
          Сделки в SOL оценены по курсу своего дня; переводы токенов — по текущей цене (≈).
        </p>

        {loading ? (
          <div className="flex items-center justify-center py-24">
            <div className="w-8 h-8 border-2 border-slate-700 border-t-emerald-400 rounded-full animate-spin" />
          </div>
        ) : error && !events.length ? (
          <div className="text-center py-16 text-slate-500">{error}</div>
        ) : !events.length ? (
          <div className="text-center py-16 text-slate-500">
            Активности не найдено — либо кошелёк пуст, либо это не Solana-адрес
          </div>
        ) : (
          <>
            {/* History depth control — kept at the top so deepening the
                window doesn't require scrolling past every section first */}
            <div className="bg-[#0d1117] border border-slate-800 rounded-xl px-4 py-3 mb-5 flex items-center gap-3 flex-wrap">
              <span className="text-xs text-slate-400 shrink-0">Догрузить ещё:</span>
              <div className="flex gap-1 bg-slate-900 rounded-lg p-1">
                {[100, 200, 500, 1000].map((n) => (
                  <button
                    key={n}
                    onClick={() => setLoadAmount(n)}
                    disabled={loadingMore}
                    className={`px-2.5 py-1 rounded-md text-xs font-medium transition-colors ${
                      loadAmount === n ? "bg-slate-700 text-white" : "text-slate-500 hover:text-slate-300"
                    }`}
                  >
                    {n} tx
                  </button>
                ))}
              </div>
              {hasMore ? (
                loadingMore && progress ? (
                  <div className="flex items-center gap-2 flex-1 min-w-[180px]">
                    <button
                      onClick={() => { cancelRef.current = true; }}
                      className="px-3 py-1.5 bg-red-500/10 border border-red-500/30 text-red-400 rounded-lg text-xs font-medium hover:bg-red-500/20 transition-colors shrink-0"
                    >
                      ■ Стоп
                    </button>
                    <div className="flex-1 h-2 bg-slate-800 rounded-full overflow-hidden min-w-[80px]">
                      <div
                        className="h-full bg-emerald-400/80 rounded-full transition-all duration-300"
                        style={{ width: `${Math.round((progress.done / progress.target) * 100)}%` }}
                      />
                    </div>
                    <span className="text-xs text-slate-400 tabular-nums shrink-0">{progress.done}/{progress.target} tx</span>
                  </div>
                ) : (
                  <button
                    onClick={loadMoreSmart}
                    className="px-4 py-1.5 bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 rounded-lg text-xs font-bold hover:bg-emerald-500/20 transition-colors"
                  >
                    ⬇ Загрузить {loadAmount} tx (≈{Math.max(Math.round((loadAmount / 100) * 22), 12)}с)
                  </button>
                )
              ) : (
                <span className="text-xs text-slate-500">✓ Вся история кошелька загружена</span>
              )}
              <span className="text-[11px] text-slate-600 ml-auto">
                загружено {rawSeen} tx · {events.length} событий
              </span>
            </div>

            {/* Stats: trading */}
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 mb-3">
              {[
                { label: "Реализ. PnL", value: fmtUsd(stats.totalPnlUsd), color: stats.totalPnlUsd >= 0 ? "text-emerald-400" : "text-red-400" },
                { label: "Win Rate", value: totalTrades ? `${winRate}% (${stats.wins}W/${stats.losses}L)` : "—", color: winRate >= 60 && totalTrades ? "text-emerald-400" : "text-slate-300" },
                { label: "Куплено", value: fmtUsd(stats.totalBuyVolumeUsd), color: "text-slate-200" },
                { label: "Продано", value: fmtUsd(stats.totalSellVolumeUsd), color: "text-slate-200" },
                { label: "Открытых позиций", value: String(stats.openPositions), color: "text-yellow-400" },
                { label: "Ср. покупка", value: stats.avgBuyUsd ? fmtUsd(stats.avgBuyUsd) : "—", color: "text-slate-300" },
              ].map((s) => (
                <div key={s.label} className="bg-[#0d1117] border border-slate-800 rounded-xl p-3">
                  <div className={`text-base font-bold ${s.color} truncate`}>{s.value}</div>
                  <div className="text-[11px] text-slate-500 mt-0.5">{s.label}</div>
                </div>
              ))}
            </div>

            {/* Stats: flows & costs */}
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 mb-6">
              {[
                { label: "SOL получено", value: flows.solIn ? flows.solIn.toFixed(2) + " ◎" : "—", color: "text-cyan-300" },
                { label: "SOL отправлено", value: flows.solOut ? flows.solOut.toFixed(2) + " ◎" : "—", color: "text-amber-300" },
                { label: "Токены получены (≈)", value: flows.transfersInUsd ? "~" + fmtUsd(flows.transfersInUsd) : "—", color: "text-sky-400" },
                { label: "Токены отправлены (≈)", value: flows.transfersOutUsd ? "~" + fmtUsd(flows.transfersOutUsd) : "—", color: "text-orange-400" },
                { label: "Комиссии сети", value: flows.feeSol ? flows.feeSol.toFixed(4) + " ◎" : "—", color: "text-slate-400" },
                { label: "Ср. удержание", value: stats.avgHoldMinutes ? (stats.avgHoldMinutes < 60 ? Math.round(stats.avgHoldMinutes) + "м" : (stats.avgHoldMinutes / 60).toFixed(1) + "ч") : "—", color: "text-slate-300" },
              ].map((s) => (
                <div key={s.label} className="bg-[#0d1117] border border-slate-800 rounded-xl p-3">
                  <div className={`text-base font-bold ${s.color} truncate`}>{s.value}</div>
                  <div className="text-[11px] text-slate-500 mt-0.5">{s.label}</div>
                </div>
              ))}
            </div>

            {/* Charts */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-6">
              <div className="bg-[#0d1117] border border-slate-800 rounded-xl p-4 overflow-visible">
                <div className="text-sm font-medium text-slate-300 mb-4">📈 Накопленный реализованный PnL</div>
                <PnlLineChart points={pnlSeries} />
              </div>
              <div className="bg-[#0d1117] border border-slate-800 rounded-xl p-4">
                <div className="text-sm font-medium text-slate-300 mb-4">📊 Объём сделок по дням</div>
                <VolumeBars days={dailyVolume} />
              </div>
            </div>

            {tokenPnlRows.length > 0 && (
              <div className="bg-[#0d1117] border border-slate-800 rounded-xl p-4 mb-6">
                <div className="text-sm font-medium text-slate-300 mb-4">🪙 PnL по токенам</div>
                <TokenPnlBars rows={tokenPnlRows} />
              </div>
            )}

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-6 items-start">
              {/* Positions */}
              <div className="bg-[#0d1117] border border-slate-800 rounded-xl overflow-hidden">
                <div className="px-4 py-3 text-sm font-medium text-slate-300 border-b border-slate-800">
                  Позиции ({sortedPositions.length})
                </div>
                <div className="divide-y divide-slate-800/50 max-h-[420px] overflow-y-auto">
                  {sortedPositions.length === 0 && (
                    <div className="px-4 py-8 text-center text-sm text-slate-600">Нет позиций в загруженном окне</div>
                  )}
                  {sortedPositions.map((p) => {
                    const tr = transfersByMint.get(p.mint);
                    return (
                      <div key={p.mint} className="px-4 py-3">
                        <div className="flex items-center gap-3">
                          <span className={`w-7 h-7 rounded-lg flex items-center justify-center text-xs shrink-0 ${
                            p.status === "open" ? "bg-yellow-500/10 text-yellow-400" : p.pnlUsd >= 0 ? "bg-emerald-500/10 text-emerald-400" : "bg-red-500/10 text-red-400"
                          }`}>
                            {p.status === "open" ? "◐" : p.pnlUsd >= 0 ? "✓" : "✕"}
                          </span>
                          <div className="flex-1 min-w-0">
                            <div className="font-semibold text-white text-sm">{symbolByMint.get(p.mint) || p.mint.slice(0, 6)}</div>
                            <div className="text-xs text-slate-500">
                              {p.buyCount} покуп. {fmtUsd(p.buyUsd)}{p.sellCount ? ` → ${p.sellCount} продаж ${fmtUsd(p.sellUsd)}` : ""}
                            </div>
                          </div>
                          <div className="text-right shrink-0">
                            {p.status === "open" && p.sellCount === 0 ? (
                              <span className="text-xs text-yellow-400">открыта</span>
                            ) : (
                              <>
                                <div className={`text-sm font-bold ${p.pnlUsd >= 0 ? "text-emerald-400" : "text-red-400"}`}>{fmtUsd(p.pnlUsd)}</div>
                                <div className={`text-[11px] ${p.pnlPct >= 0 ? "text-emerald-400/60" : "text-red-400/60"}`}>{p.pnlPct >= 0 ? "+" : ""}{p.pnlPct.toFixed(1)}%{p.status === "open" ? " · частично" : ""}</div>
                              </>
                            )}
                          </div>
                        </div>
                        {tr && (tr.inTok > 0 || tr.outTok > 0) && (
                          <div className="mt-1.5 ml-10 text-[11px] text-sky-400/80">
                            переводами: {tr.inTok > 0 && `получено ${fmtTokens(tr.inTok)}`}{tr.inTok > 0 && tr.outTok > 0 && " · "}{tr.outTok > 0 && `отправлено ${fmtTokens(tr.outTok)}`}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Counterparties */}
              <div className="bg-[#0d1117] border border-slate-800 rounded-xl overflow-hidden">
                <div className="px-4 py-3 text-sm font-medium text-slate-300 border-b border-slate-800">
                  Контрагенты по переводам ({counterparties.length})
                </div>
                <div className="divide-y divide-slate-800/50 max-h-[420px] overflow-y-auto">
                  {counterparties.length === 0 && (
                    <div className="px-4 py-8 text-center text-sm text-slate-600">Переводов с известными контрагентами не найдено</div>
                  )}
                  {counterparties.map(([addr, c]) => (
                    <div key={addr} className="flex items-center gap-3 px-4 py-3">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <Link href={`/wallet/${addr}`} className="font-mono text-sm text-slate-200 hover:text-emerald-400 transition-colors">
                            {shortAddr(addr)}
                          </Link>
                          <button onClick={() => copyAddress(addr)} className="text-slate-600 hover:text-emerald-400 text-xs" title="Скопировать">⎘</button>
                        </div>
                        <div className="text-[11px] text-slate-500">{c.count} перевод(ов) · последний {timeAgo(c.lastTs)}</div>
                      </div>
                      <div className="text-right shrink-0 text-xs space-y-0.5">
                        {c.inUsd > 0 && <div className="text-sky-400">⬇ {fmtUsd(c.inUsd)}</div>}
                        {c.outUsd > 0 && <div className="text-orange-400">⬆ {fmtUsd(c.outUsd)}</div>}
                        {c.inUsd === 0 && c.outUsd === 0 && <div className="text-slate-600">сумма неизвестна</div>}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            {/* Full event table */}
            <div className="bg-[#0d1117] border border-slate-800 rounded-xl overflow-hidden">
              <div className="flex items-center justify-between px-4 py-3 border-b border-slate-800 flex-wrap gap-2">
                <span className="text-sm font-medium text-slate-300">Все события</span>
                <div className="flex gap-1 bg-slate-900 rounded-lg p-1 flex-wrap">
                  {FILTER_TABS.map((t) => (
                    <button key={t.id} onClick={() => setTab(t.id)}
                      className={`px-2.5 py-1 rounded-md text-xs font-medium transition-colors ${
                        tab === t.id ? "bg-slate-700 text-white" : "text-slate-500 hover:text-slate-300"
                      }`}>
                      {t.label} <span className="text-slate-600">{tabCounts[t.id]}</span>
                    </button>
                  ))}
                </div>
              </div>

              <div className="hidden sm:grid grid-cols-[90px_1fr_110px_110px_130px_90px_40px] gap-3 px-4 py-2 text-[11px] text-slate-500 border-b border-slate-800 font-medium uppercase tracking-wide">
                <span>Тип</span><span>Актив</span><span className="text-right">Сумма</span>
                <span className="text-right">Кол-во</span><span>Контрагент</span><span className="text-right">Время</span><span className="text-right">Tx</span>
              </div>

              <div className="divide-y divide-slate-800/50 max-h-[560px] overflow-y-auto">
                {filteredEvents.length === 0 && (
                  <div className="px-4 py-10 text-center text-sm text-slate-600">Нет событий этого типа в загруженном окне</div>
                )}
                {filteredEvents.map((e, i) => {
                  const meta = EVENT_META[e.type];
                  const isSol = e.type === "sol_in" || e.type === "sol_out";
                  return (
                    <div key={e.signature + i} className="grid grid-cols-[90px_1fr_auto] sm:grid-cols-[90px_1fr_110px_110px_130px_90px_40px] gap-3 px-4 py-2.5 items-center hover:bg-slate-800/20">
                      <span className={`text-[11px] font-bold px-1.5 py-1 rounded text-center ${meta.cls}`}>{meta.badge}</span>
                      <span className="text-sm text-slate-200 truncate font-medium">{isSol ? "SOL" : (e.symbol || (e.mint ? e.mint.slice(0, 6) : "?"))}</span>
                      <span className="text-sm text-slate-200 text-right font-semibold">
                        {e.usd !== null && e.usd !== undefined ? (e.usdIsEstimate ? "~" : "") + fmtUsd(e.usd) : "—"}
                      </span>
                      <span className="hidden sm:block text-xs text-slate-500 text-right">
                        {isSol ? (e.sol || 0).toFixed(3) + " ◎" : e.tokens ? fmtTokens(e.tokens) : "—"}
                      </span>
                      <span className="hidden sm:block text-xs">
                        {e.counterparty ? (
                          <Link href={`/wallet/${e.counterparty}`} className="font-mono text-slate-500 hover:text-emerald-400 transition-colors">
                            {shortAddr(e.counterparty)}
                          </Link>
                        ) : (
                          <span className="text-slate-700">—</span>
                        )}
                      </span>
                      <span className="hidden sm:block text-xs text-slate-500 text-right whitespace-nowrap">{timeAgo(e.ts)}</span>
                      <a href={`https://solscan.io/tx/${e.signature}`} target="_blank" rel="noopener noreferrer"
                        className="hidden sm:block text-xs text-slate-600 hover:text-emerald-400 text-right transition-colors">↗</a>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Compact repeat of the top control — saves a scroll back up
                after reading through the table */}
            <div className="flex flex-col items-center gap-2 mt-5">
              {error && events.length > 0 && <div className="text-xs text-red-400">{error}</div>}
              {hasMore ? (
                <button
                  onClick={loadMoreSmart}
                  disabled={loadingMore}
                  className="px-5 py-2.5 bg-slate-800 hover:bg-slate-700 disabled:opacity-60 text-slate-200 font-medium rounded-xl text-sm transition-colors"
                >
                  {loadingMore && progress ? (
                    <span className="flex items-center gap-2">
                      <span className="w-4 h-4 border-2 border-slate-500 border-t-slate-200 rounded-full animate-spin" />
                      Загружаю... {progress.done}/{progress.target} tx
                    </span>
                  ) : `⬇ Загрузить ещё ${loadAmount} tx`}
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
