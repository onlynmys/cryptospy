"use client";

import { useState, useEffect, useRef } from "react";
import Link from "next/link";
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

interface Trade {
  timestamp: number;
  token: string;
  type: "buy" | "sell";
  amountUsd: number;
  priceChange?: number;
}

interface WalletDetail {
  wallet: Wallet;
  trades: Trade[];
  loading: boolean;
}

// The list starts empty on purpose — every wallet here is one the user added
// themselves, with stats computed from its real on-chain history. (There used
// to be 5 hardcoded "example" wallets with invented stats, plus a fallback
// that FABRICATED plausible-looking numbers from the address checksum when
// analysis failed. Both are gone: fake data presented as real is worse than
// an honest empty state.)

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

interface WalletSummary {
  winRate: number;
  totalTrades: number;
  totalPnlUsd: number;
  avgBuyUsd: number;
  lastActivity: number;
  openPositions: number;
}

function walletFromSummary(addr: string, s: WalletSummary, isNew = false): Wallet {
  return {
    address: addr,
    winRate: s.winRate,
    totalTrades: s.totalTrades,
    totalPnlUsd: s.totalPnlUsd,
    avgBuyUsd: s.avgBuyUsd,
    score: Math.floor(s.winRate * 0.4 + Math.min(Math.log10(Math.max(s.totalPnlUsd, 0) + 1) * 7, 35) + Math.min(s.totalTrades * 0.5, 15)),
    tags: s.winRate >= 75 ? ["🎯 Smart Money"] : s.winRate >= 60 ? ["⚡ Active"] : ["👤 Regular"],
    lastActivity: s.lastActivity || Date.now() / 1000,
    isNew,
  };
}

type ToastType = "success" | "error" | "info";
interface Toast { id: number; msg: string; type: ToastType }

// Read-modify-write helpers — always read the CURRENT localStorage value
// before writing, instead of deriving the new value from in-memory React
// state (which can drift out of sync with disk across renders/tabs and
// silently overwrite/lose previously saved entries).
function loadCustomWallets(): Wallet[] {
  try {
    const raw = localStorage.getItem("custom_wallets");
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

interface ActivityEntry {
  wallet: string;
  mint: string;
  symbol: string;
  side: "buy" | "sell";
  usd: number;
  ts: number;
  detectedAt: number;
}

export default function WalletsPage() {
  const [wallets, setWallets] = useState<Wallet[]>([]);
  const [input, setInput] = useState("");
  const [tracked, setTracked] = useState<string[]>([]);
  const [filter, setFilter] = useState("all");
  const [sortBy, setSortBy] = useState<"score" | "winRate" | "pnl">("score");
  const [loading, setLoading] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [highlightAddr, setHighlightAddr] = useState<string | null>(null);
  const [detail, setDetail] = useState<WalletDetail | null>(null);
  const [activity, setActivity] = useState<ActivityEntry[]>([]);
  const [activityUnavailable, setActivityUnavailable] = useState(false);
  const toastId = useRef(0);

  useEffect(() => {
    try {
      const saved = localStorage.getItem("tracked_wallets");
      if (saved) setTracked(JSON.parse(saved));

      setWallets(loadCustomWallets());
    } catch {}
  }, []);

  useEffect(() => {
    async function loadActivity() {
      try {
        const r = await fetch("/api/wallet-activity?limit=30", { cache: "no-store" });
        const d = await r.json();
        setActivity(d.activity || []);
        setActivityUnavailable(!!d.unavailable);
      } catch {
        setActivityUnavailable(true);
      }
    }
    loadActivity();
    const interval = setInterval(loadActivity, 30_000);
    return () => clearInterval(interval);
  }, []);

  function addToast(msg: string, type: ToastType = "success") {
    const id = ++toastId.current;
    setToasts((t) => [...t, { id, msg, type }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 3500);
  }

  function toggleTrack(addr: string, e?: React.MouseEvent) {
    e?.stopPropagation();
    const wasTracked = tracked.includes(addr);
    const updated = wasTracked ? tracked.filter((a) => a !== addr) : [...tracked, addr];
    setTracked(updated);
    localStorage.setItem("tracked_wallets", JSON.stringify(updated));
    addToast(wasTracked ? "Убрано из отслеживания" : "Добавлено ⭐ — сервер начнёт следить за новыми сделками", "info");

    // Sync to the VM's poller so it actually watches this wallet on-chain,
    // not just remembers it locally. Best-effort — a failure here just means
    // the star still works as a personal bookmark, minus live notifications.
    fetch("/api/watched-wallets", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ address: addr, action: wasTracked ? "remove" : "add" }),
    }).catch(() => {});
  }

  function removeWallet(addr: string, e: React.MouseEvent) {
    e.stopPropagation();
    setWallets((prev) => prev.filter((w) => w.address !== addr));

    const remainingCustom = loadCustomWallets().filter((w) => w.address !== addr);
    localStorage.setItem("custom_wallets", JSON.stringify(remainingCustom));

    if (detail?.wallet.address === addr) setDetail(null);
    addToast("Кошелёк удалён", "info");
  }

  async function openDetail(wallet: Wallet) {
    setDetail({ wallet, trades: [], loading: true });
    try {
      const r = await fetch(`/api/wallet-analysis?wallet=${wallet.address}`);
      const d = await r.json();

      // Refresh the row with the just-computed real summary — this also heals
      // entries saved back when stats could be stale or fabricated.
      let shown = wallet;
      if (d.summary) {
        shown = walletFromSummary(wallet.address, d.summary, wallet.isNew);
        setWallets((prev) => prev.map((w) => (w.address === wallet.address ? shown : w)));
        const custom = loadCustomWallets();
        if (custom.some((w) => w.address === wallet.address)) {
          localStorage.setItem("custom_wallets", JSON.stringify(custom.map((w) => (w.address === wallet.address ? shown : w))));
        }
      }
      setDetail({ wallet: shown, trades: d.trades || [], loading: false });
    } catch {
      setDetail({ wallet, trades: [], loading: false });
    }
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

      // Only add wallets we could actually analyze — no invented stats. If a
      // wallet has zero parseable swaps, saying so honestly beats showing a
      // plausible-looking fake.
      if (d.noKey) {
        addToast("Нет Helius API ключа — анализ кошельков недоступен", "error");
        return;
      }
      if (!d.summary) {
        addToast("По этому адресу не найдено DEX-сделок (или это не Solana-кошелёк)", "error");
        return;
      }

      const newW = walletFromSummary(addr, d.summary, true);
      setWallets((prev) => [newW, ...prev]);
      setFilter("all");
      setHighlightAddr(addr);
      setTimeout(() => setHighlightAddr(null), 3000);
      setInput("");
      localStorage.setItem("custom_wallets", JSON.stringify([newW, ...loadCustomWallets()]));
      addToast(`✓ Добавлен: ${addr.slice(0, 8)}...`);
    } catch {
      addToast("Не удалось проанализировать кошелёк — попробуй ещё раз", "error");
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
      <div className="fixed top-16 right-4 z-50 flex flex-col gap-2 pointer-events-none">
        {toasts.map((t) => (
          <div key={t.id} className={`px-4 py-3 rounded-xl text-sm font-medium shadow-xl slide-in ${
            t.type === "success" ? "bg-emerald-500 text-black" :
            t.type === "error" ? "bg-red-500 text-white" :
            "bg-slate-700 text-white"
          }`}>
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
          <div className="text-sm font-medium text-slate-300 mb-2">Добавить кошелёк</div>
          <div className="flex gap-2">
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && !loading && addWallet()}
              placeholder="Вставь Solana или EVM адрес..."
              className="flex-1 bg-slate-800 border border-slate-600 rounded-xl px-4 py-3 text-slate-200 placeholder-slate-500 focus:outline-none focus:border-emerald-500 text-sm transition-colors"
            />
            <button
              onClick={addWallet}
              disabled={loading}
              className="px-6 py-3 bg-emerald-500 hover:bg-emerald-400 disabled:opacity-60 text-black font-bold rounded-xl text-sm transition-all"
            >
              {loading ? (
                <span className="flex items-center gap-2">
                  <span className="w-4 h-4 border-2 border-black/30 border-t-black rounded-full animate-spin" />
                  Загрузка...
                </span>
              ) : "Добавить"}
            </button>
          </div>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-5">
          {[
            { label: "Всего", value: wallets.length, color: "text-white" },
            { label: "Отслеживаю", value: tracked.length, color: "text-emerald-400" },
            { label: "Smart Money", value: wallets.filter((w) => w.winRate >= 75).length, color: "text-yellow-400" },
            { label: "Ср. Win Rate", value: wallets.length ? (wallets.reduce((s, w) => s + w.winRate, 0) / wallets.length).toFixed(1) + "%" : "—", color: "text-blue-400" },
          ].map((s) => (
            <div key={s.label} className="bg-[#0d1117] border border-slate-800 rounded-xl p-3">
              <div className={`text-xl font-bold ${s.color}`}>{s.value}</div>
              <div className="text-xs text-slate-500">{s.label}</div>
            </div>
          ))}
        </div>

        {/* Live activity on tracked wallets */}
        {tracked.length > 0 && (
          <div className="bg-[#0d1117] border border-slate-700 rounded-xl p-4 mb-5">
            <div className="flex items-center gap-2 mb-3">
              <span className="w-1.5 h-1.5 bg-emerald-400 rounded-full animate-pulse" />
              <span className="text-sm font-medium text-slate-300">Активность на отслеживаемых кошельках</span>
            </div>
            {activityUnavailable ? (
              <div className="text-xs text-slate-600">Сервис отслеживания сейчас недоступен</div>
            ) : activity.filter((a) => tracked.includes(a.wallet)).length === 0 ? (
              <div className="text-xs text-slate-600">Пока новых сделок не обнаружено — сервер опрашивает кошельки в фоне</div>
            ) : (
              <div className="space-y-1.5">
                {activity.filter((a) => tracked.includes(a.wallet)).slice(0, 8).map((a, i) => (
                  <div key={i} className="flex items-center gap-3 text-sm">
                    <span className={`w-6 h-6 rounded-lg flex items-center justify-center text-xs shrink-0 ${
                      a.side === "buy" ? "bg-emerald-500/10 text-emerald-400" : "bg-red-500/10 text-red-400"
                    }`}>{a.side === "buy" ? "▲" : "▼"}</span>
                    <span className="font-mono text-xs text-slate-500 shrink-0">{a.wallet.slice(0, 6)}...</span>
                    <span className="text-slate-200 font-medium">{a.symbol}</span>
                    <span className="text-slate-500 text-xs">${a.usd.toLocaleString()}</span>
                    <span className="text-slate-600 text-xs ml-auto shrink-0">{timeAgo(a.ts)}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Filters */}
        <div className="flex flex-col sm:flex-row gap-3 mb-4">
          <div className="flex gap-1 bg-[#0d1117] border border-slate-800 rounded-xl p-1 flex-wrap">
            {[
              { id: "all", label: "Все" },
              { id: "smart", label: "🎯 Smart Money" },
              { id: "whale", label: "💎 Киты" },
              { id: "tracked", label: "⭐ Мои" },
            ].map((f) => (
              <button key={f.id} onClick={() => setFilter(f.id)}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
                  filter === f.id ? "bg-slate-700 text-white" : "text-slate-500 hover:text-slate-300"
                }`}>
                {f.label}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2 ml-auto text-sm text-slate-500">
            <span>Сорт:</span>
            {(["score", "winRate", "pnl"] as const).map((s) => (
              <button key={s} onClick={() => setSortBy(s)}
                className={`px-2 py-1 rounded transition-colors ${sortBy === s ? "text-emerald-400" : "hover:text-slate-300"}`}>
                {s === "winRate" ? "Win %" : s === "pnl" ? "PnL" : "Score"}
              </button>
            ))}
          </div>
        </div>

        {/* Table */}
        <div className="bg-[#0d1117] border border-slate-800 rounded-xl overflow-hidden">
          <div className="hidden sm:grid grid-cols-[auto_1fr_auto_auto_auto_auto_auto_auto_auto] gap-4 px-4 py-3 text-xs text-slate-500 border-b border-slate-800 font-medium uppercase tracking-wide">
            <span>#</span><span>Кошелёк</span>
            <span className="text-right">Win %</span><span className="text-right">Сделки</span>
            <span className="text-right">PnL</span><span className="text-right">Ср. покупка</span>
            <span className="text-right">Активность</span><span className="text-right">⭐</span><span className="text-right">✕</span>
          </div>

          <div className="divide-y divide-slate-800">
            {filtered.length === 0 ? (
              <div className="text-center py-12 text-slate-500">
                {filter === "tracked" ? "Нажми ☆ у кошелька чтобы отслеживать" : "Добавь кошелёк по адресу выше — статистика считается по его реальной истории сделок"}
              </div>
            ) : filtered.map((w, i) => (
              <div key={w.address}
                onClick={() => openDetail(w)}
                className={`grid grid-cols-1 sm:grid-cols-[auto_1fr_auto_auto_auto_auto_auto_auto_auto] gap-2 sm:gap-4 px-4 py-3 transition-all items-center cursor-pointer ${
                  highlightAddr === w.address
                    ? "bg-emerald-500/10 border-l-2 border-emerald-500"
                    : "hover:bg-slate-800/30"
                }`}
              >
                <span className="hidden sm:block text-slate-600 text-sm font-mono">#{i + 1}</span>

                <div>
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-sm text-slate-300">
                      {w.address.slice(0, 8)}...{w.address.slice(-6)}
                    </span>
                    {w.isNew && <span className="text-xs bg-emerald-500/20 text-emerald-400 px-1.5 py-0.5 rounded">новый</span>}
                  </div>
                  <div className="flex flex-wrap gap-1 mt-0.5">
                    {w.tags.map((t) => <span key={t} className="text-xs text-slate-500">{t}</span>)}
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
                  <button onClick={(e) => toggleTrack(w.address, e)}
                    className={`text-xl transition-colors ${tracked.includes(w.address) ? "text-yellow-400" : "text-slate-600 hover:text-yellow-400"}`}>
                    {tracked.includes(w.address) ? "★" : "☆"}
                  </button>
                </div>
                <div className="text-right">
                  <button onClick={(e) => removeWallet(w.address, e)}
                    className="text-slate-700 hover:text-red-400 transition-colors text-sm px-1">
                    ✕
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>

        <p className="text-xs text-slate-600 mt-3 text-center">
          Нажми на кошелёк чтобы увидеть историю действий
        </p>
      </main>

      {/* Wallet Detail Modal */}
      {detail && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-start justify-center p-4 overflow-y-auto"
          onClick={() => setDetail(null)}>
          <div className="bg-[#0d1117] border border-slate-700 rounded-2xl w-full max-w-lg max-h-[85vh] mt-8 flex flex-col overflow-hidden"
            onClick={(e) => e.stopPropagation()}>

            {/* Header */}
            <div className="flex items-center justify-between p-5 border-b border-slate-800 shrink-0">
              <div>
                <div className="text-white font-bold text-lg">Детали кошелька</div>
                <div className="flex items-center gap-2 mt-1">
                  <span className="font-mono text-xs text-slate-400">
                    {detail.wallet.address.slice(0, 12)}...{detail.wallet.address.slice(-8)}
                  </span>
                  <button
                    onClick={() => { navigator.clipboard?.writeText(detail.wallet.address); addToast("Адрес скопирован", "info"); }}
                    className="text-slate-500 hover:text-emerald-400 transition-colors text-sm"
                    title="Скопировать">⎘</button>
                </div>
              </div>
              <button onClick={() => setDetail(null)} className="text-slate-500 hover:text-white text-xl w-8 h-8 flex items-center justify-center">✕</button>
            </div>

            {/* Stats */}
            <div className="grid grid-cols-3 gap-3 p-5 border-b border-slate-800 shrink-0">
              {[
                { label: "Win Rate", value: detail.wallet.winRate.toFixed(1) + "%", color: detail.wallet.winRate >= 75 ? "text-emerald-400" : "text-yellow-400" },
                { label: "PnL", value: fmt(detail.wallet.totalPnlUsd), color: detail.wallet.totalPnlUsd >= 0 ? "text-emerald-400" : "text-red-400" },
                { label: "Сделок", value: detail.wallet.totalTrades.toString(), color: "text-blue-400" },
              ].map((s) => (
                <div key={s.label} className="bg-slate-800/50 rounded-xl p-3 text-center">
                  <div className={`text-xl font-bold ${s.color}`}>{s.value}</div>
                  <div className="text-xs text-slate-500">{s.label}</div>
                </div>
              ))}
            </div>

            <div className="grid grid-cols-2 gap-3 px-5 pb-4 pt-3 border-b border-slate-800 shrink-0">
              <div className="text-sm"><span className="text-slate-500">Ср. покупка: </span><span className="text-slate-200">${detail.wallet.avgBuyUsd.toLocaleString()}</span></div>
              <div className="text-sm"><span className="text-slate-500">Активность: </span><span className="text-slate-200">{timeAgo(detail.wallet.lastActivity)}</span></div>
            </div>

            {/* Tags */}
            <div className="flex gap-2 flex-wrap px-5 py-3 border-b border-slate-800 shrink-0">
              {detail.wallet.tags.map((t) => (
                <span key={t} className="text-xs bg-slate-800 text-slate-300 px-2 py-1 rounded-lg">{t}</span>
              ))}
            </div>

            {/* Trade history */}
            <div className="flex-1 min-h-0 overflow-y-auto">
              <div className="px-5 py-3 text-sm font-medium text-slate-400 border-b border-slate-800">
                История сделок
              </div>

              {detail.loading ? (
                <div className="flex items-center justify-center py-12">
                  <div className="w-6 h-6 border-2 border-slate-700 border-t-emerald-400 rounded-full animate-spin" />
                </div>
              ) : detail.trades.length === 0 ? (
                <div className="text-center py-10 text-slate-500">
                  <div className="text-3xl mb-2">📭</div>
                  <div>Нет данных о сделках</div>
                  <div className="text-xs mt-1">Добавь Helius API ключ в Settings для реальной истории</div>
                </div>
              ) : (
                <div className="divide-y divide-slate-800/50">
                  {detail.trades.map((trade, i) => (
                    <div key={i} className="flex items-center gap-3 px-5 py-3 hover:bg-slate-800/20">
                      <div className={`w-8 h-8 rounded-lg flex items-center justify-center text-sm font-bold shrink-0 ${
                        trade.type === "buy" ? "bg-emerald-500/10 text-emerald-400" : "bg-red-500/10 text-red-400"
                      }`}>
                        {trade.type === "buy" ? "▲" : "▼"}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="font-semibold text-white text-sm">{trade.token}</span>
                          <span className={`text-xs font-medium ${trade.type === "buy" ? "text-emerald-400" : "text-red-400"}`}>
                            {trade.type === "buy" ? "КУПИЛ" : "ПРОДАЛ"}
                          </span>
                        </div>
                        <div className="text-xs text-slate-500">{timeAgo(trade.timestamp)}</div>
                      </div>
                      <div className="text-right shrink-0">
                        <div className="text-sm font-semibold text-slate-200">${(trade.amountUsd ?? 0).toLocaleString()}</div>
                        {trade.priceChange !== undefined && trade.priceChange !== null && (
                          <div className={`text-xs ${trade.priceChange >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                            {trade.priceChange >= 0 ? "+" : ""}{trade.priceChange.toFixed(1)}%
                          </div>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Footer */}
            <div className="p-4 border-t border-slate-800 shrink-0 flex gap-2">
              <Link
                href={`/wallet/${detail.wallet.address}`}
                className="flex-1 text-center py-2.5 bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 rounded-xl text-sm hover:bg-emerald-500/20 transition-colors"
              >
                📊 Полная история
              </Link>
              <a
                href={`https://solscan.io/account/${detail.wallet.address}`}
                target="_blank"
                rel="noopener noreferrer"
                className="flex-1 text-center py-2.5 bg-slate-800 border border-slate-700 text-slate-300 rounded-xl text-sm hover:border-slate-600 transition-colors"
              >
                ↗ Solscan
              </a>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
