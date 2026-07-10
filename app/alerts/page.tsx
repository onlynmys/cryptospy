"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import Navbar from "@/components/Navbar";

interface RealAlert {
  id: string;
  type: "pump" | "dump" | "new_pair" | "volume_spike" | "buy_pressure" | "sell_pressure";
  tokenSymbol: string;
  tokenName: string;
  chainId: string;
  pairAddress: string;
  tokenAddress: string;
  priceUsd: string;
  priceChangeM5: number;
  priceChangeH1: number;
  priceChange24h: number;
  volumeM5: number;
  volumeH1: number;
  volumeH24: number;
  liquidityUsd: number;
  fdv: number;
  buys24h: number;
  sells24h: number;
  buysH1: number;
  sellsH1: number;
  buyPressure: number;
  pairAgeMinutes: number;
  dexId: string;
  url: string;
  timestamp: number;
  title: string;
  description: string;
  _seen?: boolean;
}

const CHAINS = [
  { id: "", label: "All" },
  { id: "solana", label: "SOL" },
  { id: "ethereum", label: "ETH" },
  { id: "bsc", label: "BSC" },
  { id: "base", label: "Base" },
];

const TYPES = [
  { id: "", label: "Все" },
  { id: "pump", label: "🚀 Памп" },
  { id: "dump", label: "📉 Дамп" },
  { id: "new_pair", label: "🆕 Новые" },
  { id: "volume_spike", label: "⚡ Объём" },
  { id: "buy_pressure", label: "🟢 Buy" },
  { id: "sell_pressure", label: "🔴 Sell" },
];

function fmtPrice(p: string): string {
  const n = parseFloat(p);
  if (!n) return "—";
  if (n < 0.000001) return "$" + n.toExponential(2);
  if (n < 0.001) return "$" + n.toFixed(6);
  if (n < 1) return "$" + n.toFixed(4);
  return "$" + n.toFixed(2);
}

function fmtVol(n: number): string {
  if (n >= 1_000_000) return "$" + (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return "$" + (n / 1_000).toFixed(1) + "K";
  return "$" + n.toFixed(0);
}

function timeAgo(ts: number): string {
  const sec = Math.floor(Date.now() / 1000 - ts);
  if (sec < 60) return "только что";
  if (sec < 3600) return Math.floor(sec / 60) + "м назад";
  return Math.floor(sec / 3600) + "ч назад";
}

function chainColor(c: string) {
  const m: Record<string, string> = {
    solana: "text-purple-400 bg-purple-400/10",
    ethereum: "text-blue-400 bg-blue-400/10",
    bsc: "text-yellow-400 bg-yellow-400/10",
    base: "text-sky-400 bg-sky-400/10",
  };
  return m[c] || "text-slate-400 bg-slate-400/10";
}

function typeStyle(t: RealAlert["type"]) {
  const m = {
    pump: { icon: "🚀", border: "border-emerald-500/30", bg: "bg-emerald-500/5" },
    dump: { icon: "📉", border: "border-red-500/30", bg: "bg-red-500/5" },
    new_pair: { icon: "🆕", border: "border-blue-500/30", bg: "bg-blue-500/5" },
    volume_spike: { icon: "⚡", border: "border-yellow-500/30", bg: "bg-yellow-500/5" },
    buy_pressure: { icon: "🟢", border: "border-emerald-400/20", bg: "bg-emerald-400/5" },
    sell_pressure: { icon: "🔴", border: "border-red-400/20", bg: "bg-red-400/5" },
  };
  return m[t] || { icon: "◈", border: "border-slate-700", bg: "" };
}

export default function AlertsPage() {
  const [alerts, setAlerts] = useState<RealAlert[]>([]);
  const [loading, setLoading] = useState(true);
  const [chain, setChain] = useState("");
  const [typeFilter, setTypeFilter] = useState("");
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [newCount, setNewCount] = useState(0);
  const [autoRefresh, setAutoRefresh] = useState(true);

  const fetchAlerts = useCallback(async (isAuto = false) => {
    try {
      const r = await fetch(`/api/alerts?chain=${chain}&t=${Date.now()}`);
      const d = await r.json();
      const incoming: RealAlert[] = d.alerts || [];

      setAlerts((prev) => {
        const prevIds = new Set(prev.map((a) => a.tokenSymbol + a.type + a.chainId));
        const fresh = incoming.filter((a) => !prevIds.has(a.tokenSymbol + a.type + a.chainId));
        if (isAuto && fresh.length > 0) setNewCount((n) => n + fresh.length);
        // Merge: new first, keep old ones below, cap at 100
        const merged = [
          ...incoming,
          ...prev.filter((p) => !incoming.find((i) => i.tokenSymbol === p.tokenSymbol && i.type === p.type && i.chainId === p.chainId)),
        ].slice(0, 100);
        return merged;
      });

      setLastUpdated(new Date());
    } finally {
      setLoading(false);
    }
  }, [chain]);

  useEffect(() => {
    setLoading(true);
    setAlerts([]);
    fetchAlerts();
  }, [chain, fetchAlerts]);

  useEffect(() => {
    if (!autoRefresh) return;
    const interval = setInterval(() => fetchAlerts(true), 30000);
    return () => clearInterval(interval);
  }, [autoRefresh, fetchAlerts]);

  const filtered = alerts.filter((a) => !typeFilter || a.type === typeFilter);

  return (
    <div className="min-h-screen">
      <Navbar />
      <main className="max-w-5xl mx-auto px-4 py-6">

        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-6">
          <div>
            <h1 className="text-2xl font-bold text-white flex items-center gap-2">
              Live Сигналы
              {newCount > 0 && (
                <span className="text-xs bg-emerald-500 text-black px-2 py-0.5 rounded-full font-normal">
                  +{newCount} новых
                </span>
              )}
            </h1>
            <p className="text-slate-500 text-sm mt-0.5">
              Реальные данные с DEX Screener
              {lastUpdated && (
                <span className="ml-2 text-slate-600">· {lastUpdated.toLocaleTimeString()}</span>
              )}
            </p>
          </div>

          <div className="flex gap-2">
            <button
              onClick={() => { setNewCount(0); fetchAlerts(); }}
              className="px-3 py-1.5 border border-slate-700 text-slate-400 hover:text-white rounded-lg text-sm transition-colors"
            >
              ↻ Обновить
            </button>
            <button
              onClick={() => setAutoRefresh(!autoRefresh)}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-sm transition-all ${
                autoRefresh
                  ? "border-emerald-500/40 text-emerald-400 bg-emerald-500/10"
                  : "border-slate-700 text-slate-500"
              }`}
            >
              <span className={`w-1.5 h-1.5 rounded-full ${autoRefresh ? "bg-emerald-400 animate-pulse" : "bg-slate-600"}`} />
              {autoRefresh ? "Авто" : "Пауза"}
            </button>
          </div>
        </div>

        {/* Chain filter */}
        <div className="flex gap-1 bg-[#0d1117] border border-slate-800 rounded-xl p-1 mb-3 w-fit">
          {CHAINS.map((c) => (
            <button
              key={c.id}
              onClick={() => setChain(c.id)}
              className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-all ${
                chain === c.id ? "bg-slate-700 text-white" : "text-slate-500 hover:text-slate-300"
              }`}
            >
              {c.label}
            </button>
          ))}
        </div>

        {/* Type filter */}
        <div className="flex gap-1 flex-wrap mb-5">
          {TYPES.map((t) => (
            <button
              key={t.id}
              onClick={() => setTypeFilter(t.id)}
              className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-all border ${
                typeFilter === t.id
                  ? "bg-slate-700 text-white border-slate-600"
                  : "text-slate-500 border-slate-800 hover:border-slate-700 hover:text-slate-300"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        {/* Stats */}
        {!loading && alerts.length > 0 && (
          <div className="grid grid-cols-3 sm:grid-cols-6 gap-2 mb-5">
            {[
              { label: "🚀 Памп", count: alerts.filter((a) => a.type === "pump").length, color: "text-emerald-400" },
              { label: "📉 Дамп", count: alerts.filter((a) => a.type === "dump").length, color: "text-red-400" },
              { label: "🆕 Новые", count: alerts.filter((a) => a.type === "new_pair").length, color: "text-blue-400" },
              { label: "⚡ Объём", count: alerts.filter((a) => a.type === "volume_spike").length, color: "text-yellow-400" },
              { label: "🟢 Buy", count: alerts.filter((a) => a.type === "buy_pressure").length, color: "text-emerald-300" },
              { label: "🔴 Sell", count: alerts.filter((a) => a.type === "sell_pressure").length, color: "text-red-300" },
            ].map((s) => (
              <div key={s.label} className="bg-[#0d1117] border border-slate-800 rounded-xl p-2 text-center">
                <div className={`text-lg font-bold ${s.color}`}>{s.count}</div>
                <div className="text-xs text-slate-600">{s.label}</div>
              </div>
            ))}
          </div>
        )}

        {/* Alerts list */}
        {loading ? (
          <div className="space-y-3">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="bg-[#0d1117] border border-slate-800 rounded-xl p-4 animate-pulse">
                <div className="flex gap-3">
                  <div className="w-10 h-10 bg-slate-800 rounded-xl" />
                  <div className="flex-1">
                    <div className="h-4 bg-slate-800 rounded w-48 mb-2" />
                    <div className="h-3 bg-slate-800 rounded w-full" />
                  </div>
                </div>
              </div>
            ))}
          </div>
        ) : filtered.length === 0 ? (
          <div className="text-center py-20 text-slate-500">
            Нет сигналов по выбранным фильтрам
          </div>
        ) : (
          <div className="space-y-2">
            {filtered.map((alert) => {
              const style = typeStyle(alert.type);
              const isUp = alert.priceChangeM5 >= 0;

              return (
                <div
                  key={alert.id}
                  className={`border rounded-xl p-4 transition-all hover:border-slate-600 ${style.border} ${style.bg}`}
                >
                  <div className="flex flex-col sm:flex-row sm:items-start gap-3">

                    {/* Left: icon + token */}
                    <div className="flex items-center gap-3 min-w-0">
                      <div className="text-2xl shrink-0">{style.icon}</div>
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-bold text-white text-lg">{alert.tokenSymbol}</span>
                          <span className="text-slate-500 text-sm truncate max-w-[120px]">{alert.tokenName}</span>
                          <span className={`text-xs px-1.5 py-0.5 rounded font-mono ${chainColor(alert.chainId)}`}>
                            {alert.chainId.slice(0, 3).toUpperCase()}
                          </span>
                          <span className="text-xs text-slate-600">{alert.dexId}</span>
                        </div>
                        <div className="text-sm text-slate-400 mt-0.5">{alert.title}</div>
                      </div>
                    </div>

                    {/* Right: time + link */}
                    <div className="sm:ml-auto flex items-center gap-3 shrink-0">
                      <span className="text-xs text-slate-600">{timeAgo(alert.timestamp)}</span>
                      <Link
                        href={`/token/${alert.chainId}/${alert.pairAddress}`}
                        className="text-xs px-2 py-1 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg transition-colors"
                      >
                        Открыть →
                      </Link>
                    </div>
                  </div>

                  {/* Metrics grid */}
                  <div className="mt-3 grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-2">
                    <div className="bg-black/20 rounded-lg p-2">
                      <div className="text-xs text-slate-500 mb-0.5">Цена</div>
                      <div className="text-sm font-mono font-semibold text-white">{fmtPrice(alert.priceUsd)}</div>
                    </div>
                    <div className="bg-black/20 rounded-lg p-2">
                      <div className="text-xs text-slate-500 mb-0.5">5 мин</div>
                      <div className={`text-sm font-semibold ${isUp ? "text-emerald-400" : "text-red-400"}`}>
                        {isUp ? "+" : ""}{alert.priceChangeM5.toFixed(2)}%
                      </div>
                    </div>
                    <div className="bg-black/20 rounded-lg p-2">
                      <div className="text-xs text-slate-500 mb-0.5">1 час</div>
                      <div className={`text-sm font-semibold ${alert.priceChangeH1 >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                        {alert.priceChangeH1 >= 0 ? "+" : ""}{alert.priceChangeH1.toFixed(2)}%
                      </div>
                    </div>
                    <div className="bg-black/20 rounded-lg p-2">
                      <div className="text-xs text-slate-500 mb-0.5">Объём 5м</div>
                      <div className="text-sm font-semibold text-slate-200">{fmtVol(alert.volumeM5)}</div>
                    </div>
                    <div className="bg-black/20 rounded-lg p-2">
                      <div className="text-xs text-slate-500 mb-0.5">Ликвидность</div>
                      <div className="text-sm font-semibold text-slate-200">{fmtVol(alert.liquidityUsd)}</div>
                    </div>
                    <div className="bg-black/20 rounded-lg p-2">
                      <div className="text-xs text-slate-500 mb-0.5">Buy/Sell 1ч</div>
                      <div className="text-sm font-semibold">
                        <span className="text-emerald-400">{alert.buysH1}</span>
                        <span className="text-slate-600"> / </span>
                        <span className="text-red-400">{alert.sellsH1}</span>
                      </div>
                    </div>
                  </div>

                  {/* Description */}
                  <div className="mt-2 text-xs text-slate-500 leading-relaxed">
                    {alert.description}
                  </div>

                  {/* Buy pressure bar */}
                  {(alert.buysH1 + alert.sellsH1) > 0 && (
                    <div className="mt-2">
                      <div className="h-1 bg-red-500/30 rounded-full overflow-hidden">
                        <div
                          className="h-full bg-emerald-500 rounded-full"
                          style={{ width: `${alert.buyPressure}%` }}
                        />
                      </div>
                      <div className="flex justify-between text-xs text-slate-600 mt-0.5">
                        <span>{alert.buyPressure}% покупок</span>
                        <span>{100 - alert.buyPressure}% продаж</span>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </main>
    </div>
  );
}
