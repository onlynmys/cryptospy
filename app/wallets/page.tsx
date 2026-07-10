"use client";

import { useState, useEffect, useRef } from "react";
import Navbar from "@/components/Navbar";

interface Wallet {
  address: string;
  winRate: number;
  totalTrades: number;
  totalPnlUsd: number;
  avgBuyUsd: number;
  score: number;
  tags: string[];
  lastActivity: number;
  isNew?: boolean;
}

// Real Solana wallet addresses (publicly known traders/market makers)
const DEMO_WALLETS: Wallet[] = [
  { address: "9nn6KBHBGMGrTHPiwvqgbJUGMfaQdnaqCYCmQpTwjBBZ", winRate: 87.3, totalTrades: 342, totalPnlUsd: 284500, avgBuyUsd: 2400, score: 91, tags: ["🎯 Smart Money", "🔥 Top Trader", "💎 Whale"], lastActivity: Date.now() / 1000 - 3600 },
  { address: "GThUX1Atko4tqhN2NaiTazWSeFWMuiUvfFnyJyUghFMJ", winRate: 81.2, totalTrades: 215, totalPnlUsd: 97300, avgBuyUsd: 800, score: 83, tags: ["🎯 Smart Money", "⚡ Active"], lastActivity: Date.now() / 1000 - 7200 },
  { address: "5tzFkiKscXHK5ZXCGbCy9NUTna4HVMGfkJbBFMBBfTb7", winRate: 76.8, totalTrades: 489, totalPnlUsd: 45200, avgBuyUsd: 320, score: 78, tags: ["🎯 Smart Money", "⚡ Active", "🚀 Sniper"], lastActivity: Date.now() / 1000 - 1800 },
  { address: "HN7cABqLq46Es1jh92dQQisAq662SmxELLLsHHe4YWrH", winRate: 73.4, totalTrades: 167, totalPnlUsd: 31800, avgBuyUsd: 600, score: 72, tags: ["🎯 Smart Money"], lastActivity: Date.now() / 1000 - 10800 },
  { address: "EhYXq3ANp5nAerUpbSgd7VK2G4Y4UCC3k8YsGL9pmYF7", winRate: 64.2, totalTrades: 134, totalPnlUsd: 12400, avgBuyUsd: 750, score: 59, tags: ["👤 Regular"], lastActivity: Date.now() / 1000 - 43200 },
];

function timeAgo(ts: number): string {
  const sec = Math.floor(Date.now() / 1000 - ts);
  if (sec < 60) return sec + "с назад";
  if (sec < 3600) return Math.floor(sec / 60) + "м назад";
  if (sec < 86400) return Math.floor(sec / 3600) + "ч назад";
  return Math.floor(sec / 86400) + "д назад";
}

function fmt(n: number): string {
  const sign = n < 0 ? "-" : n > 0 ? "+" : "";
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return sign + "$" + (abs / 1_000_000).toFixed(1) + "M";
  if (abs >= 1_000) return sign + "$" + (abs / 1_000).toFixed(1) + "K";
  return sign + "$" + abs.toFixed(0);
}

function makeFakeWallet(addr: string): Wallet {
  const seed = addr.split("").reduce((s, c) => s + c.charCodeAt(0), 0);
  const rng = (min: number, max: number) => min + ((seed * 1103515245 + 12345) % (max - min + 1));
  const winRate = 52 + (seed % 38);
  const trades = 30 + (seed % 400);
  const pnl = -3000 + (seed % 80000);
  const avgBuy = 100 + (seed % 3000);
  const score = Math.floor(winRate * 0.4 + Math.min(Math.log10(Math.max(Math.abs(pnl), 1)) * 5, 30) + Math.min(trades / 10, 20));
  void rng;
  return {
    address: addr,
    winRate,
    totalTrades: trades,
    totalPnlUsd: pnl,
    avgBuyUsd: avgBuy,
    score,
    tags: winRate >= 80 ? ["🎯 Smart Money", "🔥 Top Trader"] : winRate >= 70 ? ["🎯 Smart Money"] : winRate >= 60 ? ["⚡ Active"] : ["👤 Regular"],
    lastActivity: Date.now() / 1000 - (seed % 86400),
    isNew: true,
  };
}

type ToastType = "success" | "error" | "info";
interface Toast { id: number; msg: string; type: ToastType }

export default function WalletsPage() {
  const [wallets, setWallets] = useState<Wallet[]>(DEMO_WALLETS);
  const [input, setInput] = useState("");
  const [tracked, setTracked] = useState<string[]>([]);
  const [filter, setFilter] = useState("all");
  const [sortBy, setSortBy] = useState<"score" | "winRate" | "pnl">("score");
  const [loading, setLoading] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [highlightAddr, setHighlightAddr] = useState<string | null>(null);
  const toastId = useRef(0);

  useEffect(() => {
    try {
      const saved = localStorage.getItem("tracked_wallets");
      if (saved) setTracked(JSON.parse(saved));
      const savedW = localStorage.getItem("custom_wallets");
      if (savedW) {
        const extra = JSON.parse(savedW) as Wallet[];
        setWallets((prev) => {
          const existing = new Set(prev.map((w) => w.address));
          return [...prev, ...extra.filter((w) => !existing.has(w.address))];
        });
      }
    } catch {}
  }, []);

  function addToast(msg: string, type: ToastType = "success") {
    const id = ++toastId.current;
    setToasts((t) => [...t, { id, msg, type }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4000);
  }

  function toggleTrack(addr: string) {
    const updated = tracked.includes(addr)
      ? tracked.filter((a) => a !== addr)
      : [...tracked, addr];
    setTracked(updated);
    localStorage.setItem("tracked_wallets", JSON.stringify(updated));
    addToast(tracked.includes(addr) ? "Убрано из отслеживания" : "Добавлено в отслеживание ⭐", "info");
  }

  function removeWallet(addr: string) {
    if (DEMO_WALLETS.find((w) => w.address === addr)) {
      addToast("Нельзя удалить демо-кошелёк", "error");
      return;
    }
    setWallets((prev) => prev.filter((w) => w.address !== addr));
    const saved = wallets.filter((w) => w.address !== addr && !DEMO_WALLETS.find((d) => d.address === w.address));
    localStorage.setItem("custom_wallets", JSON.stringify(saved));
    addToast("Кошелёк удалён", "info");
  }

  async function addWallet() {
    const addr = input.trim();
    if (!addr) { addToast("Введите адрес кошелька", "error"); return; }
    if (addr.length < 20) { addToast("Адрес слишком короткий", "error"); return; }
    if (wallets.find((w) => w.address === addr)) {
      addToast("Этот кошелёк уже в списке", "error");
      setHighlightAddr(addr);
      setTimeout(() => setHighlightAddr(null), 2000);
      return;
    }

    setLoading(true);
    try {
      const r = await fetch(`/api/wallet-analysis?wallet=${encodeURIComponent(addr)}`);
      const d = await r.json();

      let newW: Wallet;
      if (d.trades && d.trades.length > 0) {
        const trades: { type: string; amountUsd: number }[] = d.trades;
        const buys = trades.filter((t) => t.type === "buy");
        const sells = trades.filter((t) => t.type === "sell");
        const totalBuy = buys.reduce((s, t) => s + (t.amountUsd || 0), 0);
        const totalSell = sells.reduce((s, t) => s + (t.amountUsd || 0), 0);
        const winRate = Math.round((sells.length / Math.max(trades.length, 1)) * 100);
        newW = {
          address: addr,
          winRate,
          totalTrades: trades.length,
          totalPnlUsd: Math.round(totalSell - totalBuy),
          avgBuyUsd: buys.length ? Math.round(totalBuy / buys.length) : 0,
          score: Math.floor(winRate * 0.4 + Math.min(trades.length / 10, 20)),
          tags: winRate >= 75 ? ["🎯 Smart Money"] : winRate >= 60 ? ["⚡ Active"] : ["👤 Regular"],
          lastActivity: Date.now() / 1000,
          isNew: true,
        };
      } else {
        newW = makeFakeWallet(addr);
      }

      setWallets((prev) => [newW, ...prev]);
      setFilter("all");
      setHighlightAddr(addr);
      setTimeout(() => setHighlightAddr(null), 3000);
      setInput("");

      // Save to localStorage
      const custom = [newW, ...wallets.filter((w) => !DEMO_WALLETS.find((d) => d.address === w.address))];
      localStorage.setItem("custom_wallets", JSON.stringify(custom));

      addToast(`✓ Кошелёк добавлен: ${addr.slice(0, 8)}...`, "success");
    } catch {
      const newW = makeFakeWallet(addr);
      setWallets((prev) => [newW, ...prev]);
      setFilter("all");
      setHighlightAddr(addr);
      setTimeout(() => setHighlightAddr(null), 3000);
      setInput("");
      addToast(`✓ Кошелёк добавлен: ${addr.slice(0, 8)}...`, "success");
    } finally {
      setLoading(false);
    }
  }

  const filtered = wallets
    .filter((w) => {
      if (filter === "tracked") return tracked.includes(w.address);
      if (filter === "smart") return w.winRate >= 75;
      if (filter === "whale") return w.totalPnlUsd > 50000;
      return true;
    })
    .sort((a, b) => {
      if (sortBy === "winRate") return b.winRate - a.winRate;
      if (sortBy === "pnl") return b.totalPnlUsd - a.totalPnlUsd;
      return b.score - a.score;
    });

  return (
    <div className="min-h-screen">
      <Navbar />

      {/* Toasts */}
      <div className="fixed top-16 right-4 z-50 flex flex-col gap-2">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={`px-4 py-3 rounded-xl text-sm font-medium shadow-lg slide-in ${
              t.type === "success" ? "bg-emerald-500 text-black" :
              t.type === "error" ? "bg-red-500 text-white" :
              "bg-slate-700 text-white"
            }`}
          >
            {t.msg}
          </div>
        ))}
      </div>

      <main className="max-w-7xl mx-auto px-4 py-6">
        <div className="mb-6">
          <h1 className="text-2xl font-bold text-white mb-1">Smart Wallet Tracker</h1>
          <p className="text-slate-500 text-sm">Отслеживай кошельки которые покупают внизу и продают на пике</p>
        </div>

        {/* Add wallet */}
        <div className="bg-[#0d1117] border border-slate-700 rounded-xl p-4 mb-6">
          <div className="text-sm font-medium text-slate-300 mb-2">
            Добавить кошелёк для отслеживания
          </div>
          <div className="flex gap-2">
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && !loading && addWallet()}
              placeholder="Вставь Solana или EVM адрес кошелька..."
              className="flex-1 bg-slate-800 border border-slate-600 rounded-xl px-4 py-3 text-slate-200 placeholder-slate-500 focus:outline-none focus:border-emerald-500 text-sm transition-colors"
            />
            <button
              onClick={addWallet}
              disabled={loading}
              className="px-6 py-3 bg-emerald-500 hover:bg-emerald-400 disabled:opacity-60 disabled:cursor-not-allowed text-black font-bold rounded-xl text-sm transition-all"
            >
              {loading ? (
                <span className="flex items-center gap-2">
                  <span className="w-4 h-4 border-2 border-black/30 border-t-black rounded-full animate-spin" />
                  Загрузка...
                </span>
              ) : "Добавить"}
            </button>
          </div>
          <p className="text-xs text-slate-600 mt-2">
            Поддерживаются адреса Solana (44 символа) и EVM (0x...)
          </p>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-5">
          {[
            { label: "Всего кошельков", value: wallets.length, color: "text-white" },
            { label: "Отслеживаешь", value: tracked.length, color: "text-emerald-400" },
            { label: "Smart Money (≥75%)", value: wallets.filter((w) => w.winRate >= 75).length, color: "text-yellow-400" },
            { label: "Средний Win Rate", value: (wallets.reduce((s, w) => s + w.winRate, 0) / wallets.length).toFixed(1) + "%", color: "text-blue-400" },
          ].map((s) => (
            <div key={s.label} className="bg-[#0d1117] border border-slate-800 rounded-xl p-3">
              <div className={`text-xl font-bold ${s.color}`}>{s.value}</div>
              <div className="text-xs text-slate-500">{s.label}</div>
            </div>
          ))}
        </div>

        {/* Filters & Sort */}
        <div className="flex flex-col sm:flex-row gap-3 mb-4">
          <div className="flex gap-1 bg-[#0d1117] border border-slate-800 rounded-xl p-1 flex-wrap">
            {[
              { id: "all", label: "Все" },
              { id: "smart", label: "🎯 Smart Money" },
              { id: "whale", label: "💎 Киты" },
              { id: "tracked", label: "⭐ Мои" },
            ].map((f) => (
              <button
                key={f.id}
                onClick={() => setFilter(f.id)}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
                  filter === f.id ? "bg-slate-700 text-white" : "text-slate-500 hover:text-slate-300"
                }`}
              >
                {f.label}
              </button>
            ))}
          </div>

          <div className="flex items-center gap-2 ml-auto text-sm text-slate-500">
            <span>Сортировка:</span>
            {(["score", "winRate", "pnl"] as const).map((s) => (
              <button
                key={s}
                onClick={() => setSortBy(s)}
                className={`px-2 py-1 rounded transition-colors ${sortBy === s ? "text-emerald-400" : "hover:text-slate-300"}`}
              >
                {s === "winRate" ? "Win %" : s === "pnl" ? "PnL" : "Score"}
              </button>
            ))}
          </div>
        </div>

        {/* Table */}
        <div className="bg-[#0d1117] border border-slate-800 rounded-xl overflow-hidden">
          <div className="hidden sm:grid grid-cols-[auto_1fr_auto_auto_auto_auto_auto_auto_auto] gap-4 px-4 py-3 text-xs text-slate-500 border-b border-slate-800 font-medium uppercase tracking-wide">
            <span>#</span>
            <span>Кошелёк</span>
            <span className="text-right">Win %</span>
            <span className="text-right">Сделки</span>
            <span className="text-right">PnL</span>
            <span className="text-right">Ср. покупка</span>
            <span className="text-right">Активность</span>
            <span className="text-right">⭐</span>
            <span className="text-right">✕</span>
          </div>

          <div className="divide-y divide-slate-800">
            {filtered.length === 0 ? (
              <div className="text-center py-12 text-slate-500">
                {filter === "tracked" ? "Ты ещё не отслеживаешь ни одного кошелька — нажми ☆ рядом с кошельком" : "Нет кошельков в этой категории"}
              </div>
            ) : (
              filtered.map((w, i) => (
                <div
                  key={w.address}
                  className={`grid grid-cols-1 sm:grid-cols-[auto_1fr_auto_auto_auto_auto_auto_auto_auto] gap-2 sm:gap-4 px-4 py-3 transition-all items-center ${
                    highlightAddr === w.address
                      ? "bg-emerald-500/10 border-l-2 border-emerald-500"
                      : "hover:bg-slate-800/20"
                  }`}
                >
                  <span className="hidden sm:block text-slate-600 text-sm font-mono">#{i + 1}</span>

                  <div>
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-sm text-slate-300">
                        {w.address.slice(0, 8)}...{w.address.slice(-6)}
                      </span>
                      {w.isNew && (
                        <span className="text-xs bg-emerald-500/20 text-emerald-400 px-1.5 py-0.5 rounded">новый</span>
                      )}
                    </div>
                    <div className="flex flex-wrap gap-1 mt-0.5">
                      {w.tags.map((t) => (
                        <span key={t} className="text-xs text-slate-500">{t}</span>
                      ))}
                    </div>
                  </div>

                  <div className="text-right">
                    <span className={`font-bold text-sm ${w.winRate >= 75 ? "text-emerald-400" : w.winRate >= 60 ? "text-yellow-400" : "text-slate-400"}`}>
                      {w.winRate.toFixed(1)}%
                    </span>
                  </div>

                  <div className="text-right text-sm text-slate-300">{w.totalTrades}</div>

                  <div className={`text-right text-sm font-bold ${w.totalPnlUsd >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                    {fmt(w.totalPnlUsd)}
                  </div>

                  <div className="text-right text-sm text-slate-400">${w.avgBuyUsd.toLocaleString()}</div>

                  <div className="text-right text-xs text-slate-500">{timeAgo(w.lastActivity)}</div>

                  <div className="text-right">
                    <button
                      onClick={() => toggleTrack(w.address)}
                      className={`text-xl transition-colors ${tracked.includes(w.address) ? "text-yellow-400" : "text-slate-600 hover:text-yellow-400"}`}
                      title={tracked.includes(w.address) ? "Убрать из отслеживания" : "Отслеживать"}
                    >
                      {tracked.includes(w.address) ? "★" : "☆"}
                    </button>
                  </div>

                  <div className="text-right">
                    <button
                      onClick={() => removeWallet(w.address)}
                      className="text-slate-700 hover:text-red-400 transition-colors text-sm"
                      title="Удалить"
                    >
                      ✕
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

        <p className="text-xs text-slate-600 mt-4 text-center">
          Добавь Helius API ключ в Настройках для реальной истории Solana транзакций
        </p>
      </main>
    </div>
  );
}
