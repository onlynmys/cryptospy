"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import Navbar from "@/components/Navbar";
import type { SmartWallet, RecentBuy } from "@/app/api/scanner/route";

function timeAgo(ts: number): string {
  const sec = Math.floor(Date.now() / 1000 - ts);
  if (sec < 60) return sec + "с назад";
  if (sec < 3600) return Math.floor(sec / 60) + "м назад";
  if (sec < 86400) return Math.floor(sec / 3600) + "ч назад";
  return Math.floor(sec / 86400) + "д назад";
}

function fmtPnl(n: number): string {
  const sign = n > 0 ? "+" : "";
  if (Math.abs(n) >= 1_000_000) return sign + "$" + (n / 1_000_000).toFixed(1) + "M";
  if (Math.abs(n) >= 1_000) return sign + "$" + (n / 1_000).toFixed(1) + "K";
  return sign + "$" + n.toFixed(0);
}

function scoreColor(s: number) {
  if (s >= 80) return "text-emerald-400 bg-emerald-400/10 border-emerald-400/30";
  if (s >= 60) return "text-yellow-400 bg-yellow-400/10 border-yellow-400/30";
  return "text-slate-400 bg-slate-800 border-slate-700";
}

function StatusBadge({ status, change }: { status: RecentBuy["status"]; change?: number }) {
  if (status === "sold_profit") return (
    <span className="text-xs bg-emerald-500/10 text-emerald-400 px-1.5 py-0.5 rounded font-medium">
      ✓ +{change?.toFixed(1)}%
    </span>
  );
  if (status === "sold_loss") return (
    <span className="text-xs bg-red-500/10 text-red-400 px-1.5 py-0.5 rounded font-medium">
      ✗ {change?.toFixed(1)}%
    </span>
  );
  return <span className="text-xs bg-blue-500/10 text-blue-400 px-1.5 py-0.5 rounded font-medium">⏳ держит</span>;
}

function WalletRow({ wallet, onCopy }: { wallet: SmartWallet; onCopy: (addr: string) => void }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="border border-slate-800 rounded-xl overflow-hidden hover:border-slate-700 transition-all">
      {/* Main row */}
      <div
        className="flex flex-col sm:flex-row sm:items-center gap-3 p-4 cursor-pointer hover:bg-slate-800/20 transition-colors"
        onClick={() => setExpanded(!expanded)}
      >
        {/* Address + tags */}
        <div className="flex items-center gap-3 flex-1 min-w-0">
          <div className={`text-sm font-bold px-2 py-1 rounded-lg border ${scoreColor(wallet.score)}`}>
            {wallet.score}
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-mono text-sm text-slate-200">
                {wallet.address.slice(0, 8)}...{wallet.address.slice(-6)}
              </span>
              <button
                onClick={(e) => { e.stopPropagation(); onCopy(wallet.address); }}
                className="text-slate-600 hover:text-emerald-400 transition-colors"
                title="Копировать адрес"
              >⎘</button>
            </div>
            <div className="flex flex-wrap gap-1 mt-1">
              {wallet.tags.map((t) => (
                <span key={t} className="text-xs text-slate-500">{t}</span>
              ))}
            </div>
          </div>
        </div>

        {/* Stats */}
        <div className="flex items-center gap-4 sm:gap-6 shrink-0">
          <div className="text-center">
            <div className={`text-lg font-bold ${wallet.winRate >= 70 ? "text-emerald-400" : wallet.winRate >= 55 ? "text-yellow-400" : "text-red-400"}`}>
              {wallet.winRate}%
            </div>
            <div className="text-xs text-slate-600">Win Rate</div>
          </div>
          <div className="text-center">
            <div className={`text-lg font-bold ${wallet.totalPnlUsd >= 0 ? "text-emerald-400" : "text-red-400"}`}>
              {fmtPnl(wallet.totalPnlUsd)}
            </div>
            <div className="text-xs text-slate-600">PnL</div>
          </div>
          <div className="text-center">
            <div className="text-lg font-bold text-slate-200">{wallet.totalTrades}</div>
            <div className="text-xs text-slate-600">Сделок</div>
          </div>
          <div className="text-center hidden sm:block">
            <div className="text-lg font-bold text-slate-200">${wallet.avgBuyUsd.toLocaleString()}</div>
            <div className="text-xs text-slate-600">Ср. покупка</div>
          </div>
          <div className="text-slate-600 text-sm">{expanded ? "▲" : "▼"}</div>
        </div>
      </div>

      {/* Expanded: recent buys */}
      {expanded && (
        <div className="border-t border-slate-800 bg-slate-900/30">
          <div className="px-4 py-3 text-xs text-slate-500 font-medium uppercase tracking-wide">
            Последние покупки
          </div>

          {wallet.recentBuys.length === 0 ? (
            <div className="px-4 pb-4 text-slate-600 text-sm">Нет данных</div>
          ) : (
            <div className="divide-y divide-slate-800/50">
              {wallet.recentBuys.map((buy, i) => (
                <div key={i} className="flex items-center gap-3 px-4 py-3">
                  <div className="w-8 h-8 rounded-lg bg-emerald-500/10 flex items-center justify-center text-emerald-400 text-xs font-bold shrink-0">
                    ▲
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-white font-semibold">{buy.tokenSymbol}</span>
                      <StatusBadge status={buy.status} change={buy.priceChangeAfter} />
                    </div>
                    <div className="text-xs text-slate-500">{timeAgo(buy.buyTime)}</div>
                  </div>
                  <div className="text-right shrink-0">
                    <div className="text-sm font-semibold text-slate-200">${buy.buyAmountUsd.toLocaleString()}</div>
                    {buy.pairAddress && (
                      <Link
                        href={`/token/solana/${buy.pairAddress}`}
                        className="text-xs text-slate-600 hover:text-emerald-400 transition-colors"
                        onClick={(e) => e.stopPropagation()}
                      >
                        chart →
                      </Link>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}

          <div className="flex gap-2 px-4 pb-4 pt-2">
            <a
              href={`https://solscan.io/account/${wallet.address}`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs px-3 py-1.5 border border-slate-700 text-slate-400 hover:text-white rounded-lg transition-colors"
            >
              ↗ Solscan
            </a>
            <a
              href={`https://birdeye.so/profile/${wallet.address}?chain=solana`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs px-3 py-1.5 border border-slate-700 text-slate-400 hover:text-white rounded-lg transition-colors"
            >
              ↗ Birdeye
            </a>
            <button
              onClick={() => {
                navigator.clipboard?.writeText(wallet.address);
              }}
              className="text-xs px-3 py-1.5 border border-emerald-500/30 text-emerald-400 hover:bg-emerald-500/10 rounded-lg transition-colors"
            >
              ⎘ Копировать адрес
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export default function ScannerPage() {
  const [wallets, setWallets] = useState<SmartWallet[]>([]);
  const [loading, setLoading] = useState(false);
  const [meta, setMeta] = useState<{ real: boolean; hasApiKey: boolean; message?: string; scannedPairs?: number; scannedWallets?: number } | null>(null);
  const [lastScan, setLastScan] = useState<Date | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [sortBy, setSortBy] = useState<"score" | "winRate" | "pnl">("score");
  const [filterTag, setFilterTag] = useState("");

  const scan = useCallback(async (force = false) => {
    setLoading(true);
    try {
      const r = await fetch(`/api/scanner${force ? "?refresh=1" : ""}`);
      const d = await r.json();
      setWallets(d.wallets || []);
      setMeta({ real: d.real, hasApiKey: d.hasApiKey, message: d.message, scannedPairs: d.scannedPairs, scannedWallets: d.scannedWallets });
      setLastScan(new Date());
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    scan();
    const interval = setInterval(() => scan(), 5 * 60 * 1000); // auto-refresh every 5 min
    return () => clearInterval(interval);
  }, [scan]);

  function copyAddr(addr: string) {
    navigator.clipboard?.writeText(addr);
    setCopied(addr);
    setTimeout(() => setCopied(null), 2000);
  }

  const allTags = Array.from(new Set(wallets.flatMap((w) => w.tags)));

  const displayed = wallets
    .filter((w) => !filterTag || w.tags.includes(filterTag))
    .sort((a, b) => {
      if (sortBy === "winRate") return b.winRate - a.winRate;
      if (sortBy === "pnl") return b.totalPnlUsd - a.totalPnlUsd;
      return b.score - a.score;
    });

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
            <h1 className="text-2xl font-bold text-white flex items-center gap-2">
              🧠 Smart Money Scanner
            </h1>
            <p className="text-slate-500 text-sm mt-1">
              Автоматически находит кошельки которые торгуют в плюс на Solana DEX
            </p>
            {lastScan && (
              <p className="text-slate-600 text-xs mt-1">
                Последнее сканирование: {lastScan.toLocaleTimeString()}
                {meta?.scannedPairs && ` · ${meta.scannedPairs} пар, ${meta.scannedWallets} кошельков`}
              </p>
            )}
          </div>

          <div className="flex items-center gap-2 shrink-0">
            {meta && (
              <span className={`text-xs px-2 py-1 rounded-full font-medium flex items-center gap-1.5 ${
                meta.real
                  ? "bg-emerald-500/10 text-emerald-400 border border-emerald-500/20"
                  : "bg-slate-800 text-slate-500"
              }`}>
                <span className={`w-1.5 h-1.5 rounded-full ${meta.real ? "bg-emerald-400 animate-pulse" : "bg-slate-600"}`} />
                {meta.real ? "On-chain данные" : "Демо режим"}
              </span>
            )}
            <button
              onClick={() => scan(true)}
              disabled={loading}
              className="px-4 py-2 bg-emerald-500 hover:bg-emerald-400 disabled:opacity-50 text-black font-semibold rounded-xl text-sm transition-all flex items-center gap-2"
            >
              {loading ? (
                <><span className="w-4 h-4 border-2 border-black/30 border-t-black rounded-full animate-spin" />Сканирую...</>
              ) : (
                <>🔍 Сканировать</>
              )}
            </button>
          </div>
        </div>

        {/* No API key banner */}
        {meta && !meta.hasApiKey && (
          <div className="bg-blue-500/10 border border-blue-500/20 rounded-xl p-4 mb-6 flex flex-col sm:flex-row items-start sm:items-center gap-3">
            <div className="text-2xl shrink-0">🔑</div>
            <div className="flex-1">
              <div className="text-white font-medium">Подключи Helius API для реального сканирования</div>
              <div className="text-slate-400 text-sm mt-0.5">
                Сейчас показываются демо-данные. Helius бесплатный — 1M запросов/месяц, настройка займёт 2 минуты.
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
              { label: "Найдено кошельков", value: wallets.length, color: "text-white" },
              { label: "Win Rate ≥ 70%", value: wallets.filter((w) => w.winRate >= 70).length, color: "text-emerald-400" },
              { label: "Суммарный PnL", value: fmtPnl(wallets.reduce((s, w) => s + w.totalPnlUsd, 0)), color: "text-emerald-400" },
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
              <button onClick={() => setFilterTag("")}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all border ${!filterTag ? "bg-slate-700 text-white border-slate-600" : "text-slate-500 border-slate-800 hover:text-slate-300"}`}>
                Все
              </button>
              {allTags.map((t) => (
                <button key={t} onClick={() => setFilterTag(filterTag === t ? "" : t)}
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

        {/* Wallet list */}
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
              Сканирую активные пары и анализирую кошельки...
            </div>
          </div>
        ) : displayed.length === 0 ? (
          <div className="text-center py-20 text-slate-500">Нет кошельков по фильтру</div>
        ) : (
          <div className="space-y-2">
            {displayed.map((w) => (
              <WalletRow key={w.address} wallet={w} onCopy={copyAddr} />
            ))}
          </div>
        )}

        <p className="text-xs text-slate-600 text-center mt-6">
          Нажми на кошелёк чтобы увидеть его последние сделки · Автообновление каждые 5 минут
        </p>
      </main>
    </div>
  );
}
