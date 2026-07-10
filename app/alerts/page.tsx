"use client";

import { useState, useEffect, useRef } from "react";
import Navbar from "@/components/Navbar";

interface Alert {
  id: string;
  type: "buy" | "sell" | "volume" | "price";
  tokenSymbol: string;
  chain: string;
  pairAddress: string;
  amount?: number;
  priceChange?: number;
  walletTag?: string;
  timestamp: number;
  read: boolean;
}

// Simulate live alerts for demo
function generateAlert(i: number): Alert {
  const tokens = ["BONK", "WIF", "POPCAT", "BOME", "MEW", "MYRO", "ZEUS", "JUP"];
  const chains = ["solana", "ethereum", "bsc", "base"];
  const tags = ["🎯 Smart Money", "🔥 Top Trader", "💎 Whale", "🚀 Sniper"];
  const types: Alert["type"][] = ["buy", "sell", "buy", "buy", "volume"];
  const token = tokens[i % tokens.length];
  const type = types[i % types.length];

  return {
    id: `alert-${Date.now()}-${i}`,
    type,
    tokenSymbol: token,
    chain: chains[i % chains.length],
    pairAddress: "demo" + i,
    amount: Math.floor(500 + Math.random() * 50000),
    priceChange: type === "volume" ? undefined : (type === "buy" ? 1 : -1) * (Math.random() * 30),
    walletTag: tags[i % tags.length],
    timestamp: Date.now() / 1000 - i * 90,
    read: i > 2,
  };
}

function timeAgo(ts: number): string {
  const sec = Math.floor(Date.now() / 1000 - ts);
  if (sec < 60) return "just now";
  if (sec < 3600) return Math.floor(sec / 60) + "m ago";
  return Math.floor(sec / 3600) + "h ago";
}

function AlertIcon({ type }: { type: Alert["type"] }) {
  const map = {
    buy: { icon: "▲", cls: "text-emerald-400 bg-emerald-400/10" },
    sell: { icon: "▼", cls: "text-red-400 bg-red-400/10" },
    volume: { icon: "⚡", cls: "text-yellow-400 bg-yellow-400/10" },
    price: { icon: "◈", cls: "text-blue-400 bg-blue-400/10" },
  };
  const { icon, cls } = map[type];
  return (
    <div className={`w-8 h-8 rounded-lg flex items-center justify-center text-sm font-bold ${cls}`}>
      {icon}
    </div>
  );
}

export default function AlertsPage() {
  const [alerts, setAlerts] = useState<Alert[]>(() => Array.from({ length: 15 }, (_, i) => generateAlert(i)));
  const [filter, setFilter] = useState<"all" | "buy" | "sell" | "volume">("all");
  const [liveMode, setLiveMode] = useState(true);
  const [newAlerts, setNewAlerts] = useState(0);
  const counterRef = useRef(0);

  useEffect(() => {
    if (!liveMode) return;
    const interval = setInterval(() => {
      const newAlert = generateAlert(counterRef.current++);
      newAlert.read = false;
      setAlerts((prev) => [newAlert, ...prev.slice(0, 49)]);
      setNewAlerts((n) => n + 1);
    }, 8000 + Math.random() * 7000);
    return () => clearInterval(interval);
  }, [liveMode]);

  function markAllRead() {
    setAlerts((prev) => prev.map((a) => ({ ...a, read: true })));
    setNewAlerts(0);
  }

  const filtered = alerts.filter((a) => filter === "all" || a.type === filter);
  const unread = alerts.filter((a) => !a.read).length;

  return (
    <div className="min-h-screen">
      <Navbar />
      <main className="max-w-4xl mx-auto px-4 py-6">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-bold text-white mb-1 flex items-center gap-2">
              Live Alerts
              {unread > 0 && (
                <span className="text-xs bg-red-500 text-white px-2 py-0.5 rounded-full font-normal">
                  {unread} new
                </span>
              )}
            </h1>
            <p className="text-slate-500 text-sm">Smart money movements in real-time</p>
          </div>
          <div className="flex gap-2">
            {unread > 0 && (
              <button
                onClick={markAllRead}
                className="text-xs px-3 py-1.5 border border-slate-700 text-slate-400 hover:text-white rounded-lg transition-colors"
              >
                Mark all read
              </button>
            )}
            <button
              onClick={() => setLiveMode(!liveMode)}
              className={`flex items-center gap-2 text-xs px-3 py-1.5 rounded-lg border transition-all ${
                liveMode
                  ? "border-emerald-500/40 text-emerald-400 bg-emerald-500/10"
                  : "border-slate-700 text-slate-500"
              }`}
            >
              <span className={`w-1.5 h-1.5 rounded-full ${liveMode ? "bg-emerald-400 animate-pulse" : "bg-slate-600"}`} />
              {liveMode ? "Live" : "Paused"}
            </button>
          </div>
        </div>

        {/* Filter tabs */}
        <div className="flex gap-1 bg-[#0d1117] border border-slate-800 rounded-xl p-1 mb-5 w-fit">
          {(["all", "buy", "sell", "volume"] as const).map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-all capitalize ${
                filter === f ? "bg-slate-700 text-white" : "text-slate-500 hover:text-slate-300"
              }`}
            >
              {f === "buy" ? "▲ Buys" : f === "sell" ? "▼ Sells" : f === "volume" ? "⚡ Volume" : "All"}
            </button>
          ))}
        </div>

        {/* Alert list */}
        <div className="space-y-2">
          {filtered.map((alert) => (
            <div
              key={alert.id}
              onClick={() => setAlerts((prev) => prev.map((a) => a.id === alert.id ? { ...a, read: true } : a))}
              className={`flex items-start gap-3 p-4 rounded-xl border transition-all cursor-pointer slide-in ${
                !alert.read
                  ? "bg-[#0d1117] border-slate-700 hover:border-slate-600"
                  : "bg-[#0a0e17] border-slate-800/50 hover:border-slate-700"
              }`}
            >
              {!alert.read && (
                <div className="w-1.5 h-1.5 rounded-full bg-emerald-400 mt-2 shrink-0 animate-pulse-green" />
              )}
              {alert.read && <div className="w-1.5 h-1.5 shrink-0 mt-2" />}

              <AlertIcon type={alert.type} />

              <div className="flex-1 min-w-0">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <span className="font-semibold text-white">{alert.tokenSymbol}</span>
                    <span className="text-slate-500 text-sm ml-2">
                      {alert.type === "buy" ? "Smart buy" : alert.type === "sell" ? "Smart sell" : "Volume spike"}
                    </span>
                    {alert.walletTag && (
                      <span className="ml-2 text-xs text-slate-500">{alert.walletTag}</span>
                    )}
                  </div>
                  <span className="text-xs text-slate-600 shrink-0">{timeAgo(alert.timestamp)}</span>
                </div>

                <div className="flex items-center gap-3 mt-1 text-sm">
                  {alert.amount && (
                    <span className={`font-semibold ${alert.type === "buy" ? "text-emerald-400" : alert.type === "sell" ? "text-red-400" : "text-yellow-400"}`}>
                      ${alert.amount.toLocaleString()}
                    </span>
                  )}
                  {alert.priceChange !== undefined && (
                    <span className={`text-xs ${alert.priceChange >= 0 ? "text-emerald-400/70" : "text-red-400/70"}`}>
                      {alert.priceChange >= 0 ? "+" : ""}{alert.priceChange.toFixed(1)}%
                    </span>
                  )}
                  <span className="text-xs text-slate-600 uppercase">{alert.chain}</span>
                </div>
              </div>
            </div>
          ))}
        </div>

        {filtered.length === 0 && (
          <div className="text-center py-16 text-slate-500">No alerts in this category</div>
        )}

        <p className="text-xs text-slate-600 mt-6 text-center">
          Demo simulation shown · Connect your wallets in Settings to get real alerts
        </p>
      </main>
    </div>
  );
}
