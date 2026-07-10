"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import Navbar from "@/components/Navbar";
import type { SmartWallet, RecentBuy, TokenPositionInfo } from "@/app/api/scanner/route";

function timeAgo(ts: number): string {
  const sec = Math.floor(Date.now() / 1000 - ts);
  if (sec < 60) return sec + "с назад";
  if (sec < 3600) return Math.floor(sec / 60) + "м назад";
  if (sec < 86400) return Math.floor(sec / 3600) + "ч назад";
  return Math.floor(sec / 86400) + "д назад";
}

function holdLabel(min: number): string {
  if (min < 1) return "<1м";
  if (min < 60) return Math.round(min) + "м";
  if (min < 1440) return (min / 60).toFixed(1) + "ч";
  return (min / 1440).toFixed(1) + "д";
}

function fmtUsd(n: number, sign = false): string {
  const s = sign && n > 0 ? "+" : "";
  if (Math.abs(n) >= 1_000_000) return s + "$" + (n / 1_000_000).toFixed(1) + "M";
  if (Math.abs(n) >= 1_000) return s + "$" + (n / 1_000).toFixed(1) + "K";
  return s + "$" + n.toFixed(0);
}

function scoreColor(s: number) {
  if (s >= 80) return "text-emerald-400 bg-emerald-400/10 border-emerald-400/30";
  if (s >= 60) return "text-yellow-400 bg-yellow-400/10 border-yellow-400/30";
  return "text-slate-400 bg-slate-800 border-slate-700";
}

function StatusBadge({ status, change }: { status: RecentBuy["status"]; change?: number }) {
  if (status === "sold_profit") return (
    <span className="text-xs bg-emerald-500/10 text-emerald-400 px-1.5 py-0.5 rounded font-medium">
      токен вырос {change !== undefined ? `+${change.toFixed(1)}%` : ""}
    </span>
  );
  if (status === "sold_loss") return (
    <span className="text-xs bg-red-500/10 text-red-400 px-1.5 py-0.5 rounded font-medium">
      токен упал {change !== undefined ? `${change.toFixed(1)}%` : ""}
    </span>
  );
  return <span className="text-xs bg-blue-500/10 text-blue-400 px-1.5 py-0.5 rounded font-medium">⏳ держит</span>;
}

function PositionRow({ pos }: { pos: TokenPositionInfo }) {
  const isOpen = pos.status === "open";
  const isProfit = pos.pnlUsd > 0;

  return (
    <div className="flex items-center gap-3 px-4 py-2.5 hover:bg-slate-800/20 transition-colors">
      <div className={`w-8 h-8 rounded-lg flex items-center justify-center text-xs font-bold shrink-0 ${
        isOpen ? "bg-blue-500/10 text-blue-400" : isProfit ? "bg-emerald-500/10 text-emerald-400" : "bg-red-500/10 text-red-400"
      }`}>
        {isOpen ? "⏳" : isProfit ? "✓" : "✗"}
      </div>

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-white font-semibold text-sm">{pos.symbol}</span>
          {isOpen ? (
            <span className="text-xs bg-blue-500/10 text-blue-400 px-1.5 py-0.5 rounded">открыта</span>
          ) : (
            <span className={`text-xs px-1.5 py-0.5 rounded font-bold ${isProfit ? "bg-emerald-500/10 text-emerald-400" : "bg-red-500/10 text-red-400"}`}>
              {pos.pnlPct > 0 ? "+" : ""}{pos.pnlPct}%
            </span>
          )}
        </div>
        <div className="text-xs text-slate-500 mt-0.5">
          {pos.buyCount} покуп. на {fmtUsd(pos.buyUsd)}
          {pos.sellCount > 0 && <> → {pos.sellCount} продаж на {fmtUsd(pos.sellUsd)}</>}
          {!isOpen && pos.holdMinutes > 0 && <> · держал {holdLabel(pos.holdMinutes)}</>}
        </div>
      </div>

      <div className="text-right shrink-0">
        {isOpen ? (
          <div className="text-sm font-semibold text-blue-400">{fmtUsd(pos.buyUsd)}</div>
        ) : (
          <div className={`text-sm font-bold ${isProfit ? "text-emerald-400" : "text-red-400"}`}>
            {fmtUsd(pos.pnlUsd, true)}
          </div>
        )}
        <div className="text-xs text-slate-600">{timeAgo(pos.lastTs)}</div>
      </div>
    </div>
  );
}

function WalletRow({ wallet, onCopy }: { wallet: SmartWallet; onCopy: (addr: string) => void }) {
  const [expanded, setExpanded] = useState(false);
  const accountAge = wallet.firstActivity
    ? Math.max(1, Math.round((Date.now() / 1000 - wallet.firstActivity) / 86400))
    : null;

  return (
    <div className="border border-slate-800 rounded-xl overflow-hidden hover:border-slate-700 transition-all">
      {/* Main row */}
      <div
        className="flex flex-col sm:flex-row sm:items-center gap-3 p-4 cursor-pointer hover:bg-slate-800/20 transition-colors"
        onClick={() => setExpanded(!expanded)}
      >
        <div className="flex items-center gap-3 flex-1 min-w-0">
          <div className={`text-sm font-bold px-2 py-1 rounded-lg border shrink-0 ${scoreColor(wallet.score)}`}>
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
              <span className="text-xs text-slate-600">{timeAgo(wallet.lastActivity)}</span>
            </div>
            <div className="flex flex-wrap gap-1 mt-1">
              {wallet.tags.map((t) => (
                <span key={t} className="text-xs text-slate-500">{t}</span>
              ))}
            </div>
          </div>
        </div>

        <div className="flex items-center gap-4 sm:gap-5 shrink-0">
          <div className="text-center">
            <div className={`text-lg font-bold ${wallet.winRate >= 70 ? "text-emerald-400" : wallet.winRate >= 55 ? "text-yellow-400" : "text-red-400"}`}>
              {wallet.winRate}%
            </div>
            <div className="text-xs text-slate-600">{wallet.wins}W / {wallet.losses}L</div>
          </div>
          <div className="text-center">
            <div className={`text-lg font-bold ${wallet.totalPnlUsd >= 0 ? "text-emerald-400" : "text-red-400"}`}>
              {fmtUsd(wallet.totalPnlUsd, true)}
            </div>
            <div className="text-xs text-slate-600">PnL</div>
          </div>
          <div className="text-center hidden sm:block">
            <div className="text-lg font-bold text-slate-200">{fmtUsd(wallet.totalBuyVolumeUsd)}</div>
            <div className="text-xs text-slate-600">Объём</div>
          </div>
          <div className="text-slate-600 text-sm">{expanded ? "▲" : "▼"}</div>
        </div>
      </div>

      {/* Expanded */}
      {expanded && (
        <div className="border-t border-slate-800 bg-slate-900/30">

          {/* Detailed stats grid */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 p-4">
            {[
              { label: "Закрытых сделок", value: `${wallet.totalTrades} (${wallet.wins}W/${wallet.losses}L)` },
              { label: "Открытых позиций", value: wallet.openPositions.toString() },
              { label: "Куплено всего", value: fmtUsd(wallet.totalBuyVolumeUsd) },
              { label: "Продано всего", value: fmtUsd(wallet.totalSellVolumeUsd) },
              { label: "Ср. размер покупки", value: fmtUsd(wallet.avgBuyUsd) },
              { label: "Ср. время удержания", value: wallet.avgHoldMinutes > 0 ? holdLabel(wallet.avgHoldMinutes) : "—" },
              { label: "Возраст истории", value: accountAge ? accountAge + "д" : "—" },
              { label: "Последняя активность", value: timeAgo(wallet.lastActivity) },
            ].map((s) => (
              <div key={s.label} className="bg-black/20 rounded-lg p-2.5">
                <div className="text-xs text-slate-500 mb-0.5">{s.label}</div>
                <div className="text-sm font-semibold text-slate-200">{s.value}</div>
              </div>
            ))}
          </div>

          {/* Best / worst trade */}
          {(wallet.bestTrade || wallet.worstTrade) && (
            <div className="grid grid-cols-2 gap-2 px-4 pb-3">
              {wallet.bestTrade && (
                <div className="bg-emerald-500/5 border border-emerald-500/20 rounded-lg p-2.5">
                  <div className="text-xs text-slate-500">🏆 Лучшая сделка</div>
                  <div className="text-sm font-bold text-emerald-400 mt-0.5">
                    {wallet.bestTrade.symbol} {fmtUsd(wallet.bestTrade.pnlUsd, true)} ({wallet.bestTrade.pnlPct > 0 ? "+" : ""}{wallet.bestTrade.pnlPct}%)
                  </div>
                </div>
              )}
              {wallet.worstTrade && wallet.worstTrade.pnlUsd < 0 && (
                <div className="bg-red-500/5 border border-red-500/20 rounded-lg p-2.5">
                  <div className="text-xs text-slate-500">💀 Худшая сделка</div>
                  <div className="text-sm font-bold text-red-400 mt-0.5">
                    {wallet.worstTrade.symbol} {fmtUsd(wallet.worstTrade.pnlUsd, true)} ({wallet.worstTrade.pnlPct}%)
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Live buys on trending pairs */}
          {wallet.recentBuys.length > 0 && (
            <>
              <div className="px-4 pt-2 pb-1 text-xs text-slate-500 font-medium uppercase tracking-wide flex items-center gap-2">
                <span className="w-1.5 h-1.5 bg-emerald-400 rounded-full animate-pulse" />
                Сейчас покупает (на трендовых парах)
              </div>
              <div className="divide-y divide-slate-800/50">
                {wallet.recentBuys.map((buy, i) => (
                  <div key={i} className="flex items-center gap-3 px-4 py-2.5">
                    <div className="w-8 h-8 rounded-lg bg-emerald-500/10 flex items-center justify-center text-emerald-400 text-xs font-bold shrink-0">▲</div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-white font-semibold text-sm">{buy.tokenSymbol}</span>
                        <StatusBadge status={buy.status} change={buy.priceChangeAfter} />
                      </div>
                      <div className="text-xs text-slate-500">{timeAgo(buy.buyTime)}</div>
                    </div>
                    <div className="text-right shrink-0">
                      <div className="text-sm font-semibold text-slate-200">{fmtUsd(buy.buyAmountUsd)}</div>
                      {buy.pairAddress && (
                        <Link
                          href={`/token/solana/${buy.pairAddress}`}
                          className="text-xs text-slate-600 hover:text-emerald-400 transition-colors"
                          onClick={(e) => e.stopPropagation()}
                        >график →</Link>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}

          {/* Position history */}
          {wallet.positions && wallet.positions.length > 0 && (
            <>
              <div className="px-4 pt-3 pb-1 text-xs text-slate-500 font-medium uppercase tracking-wide">
                История позиций ({wallet.positions.filter((p) => p.status === "closed").length} закрыто, {wallet.positions.filter((p) => p.status === "open").length} открыто)
              </div>
              <div className="divide-y divide-slate-800/50">
                {wallet.positions.map((pos, i) => (
                  <PositionRow key={pos.mint + i} pos={pos} />
                ))}
              </div>
            </>
          )}

          {/* Actions */}
          <div className="flex gap-2 px-4 py-4 flex-wrap">
            <a
              href={`https://solscan.io/account/${wallet.address}`}
              target="_blank" rel="noopener noreferrer"
              className="text-xs px-3 py-1.5 border border-slate-700 text-slate-400 hover:text-white rounded-lg transition-colors"
            >↗ Solscan</a>
            <a
              href={`https://birdeye.so/profile/${wallet.address}?chain=solana`}
              target="_blank" rel="noopener noreferrer"
              className="text-xs px-3 py-1.5 border border-slate-700 text-slate-400 hover:text-white rounded-lg transition-colors"
            >↗ Birdeye</a>
            <a
              href={`https://gmgn.ai/sol/address/${wallet.address}`}
              target="_blank" rel="noopener noreferrer"
              className="text-xs px-3 py-1.5 border border-slate-700 text-slate-400 hover:text-white rounded-lg transition-colors"
            >↗ GMGN</a>
            <button
              onClick={() => onCopy(wallet.address)}
              className="text-xs px-3 py-1.5 border border-emerald-500/30 text-emerald-400 hover:bg-emerald-500/10 rounded-lg transition-colors"
            >⎘ Копировать адрес</button>
          </div>
        </div>
      )}
    </div>
  );
}

interface ScanMeta {
  real: boolean;
  hasApiKey: boolean;
  message?: string;
  cached?: boolean;
  scannedPairs?: number;
  scannedWallets?: number;
  passedFilter?: number;
  rejected?: number;
  heliusRequests?: number;
  durationSec?: number;
  lastScanTs?: number;
}

export default function ScannerPage() {
  const [wallets, setWallets] = useState<SmartWallet[]>([]);
  const [loading, setLoading] = useState(false);
  const [meta, setMeta] = useState<ScanMeta | null>(null);
  const [lastScan, setLastScan] = useState<Date | null>(null);
  const [copied, setCopied] = useState(false);
  const [sortBy, setSortBy] = useState<"score" | "winRate" | "pnl">("score");
  const [filterTag, setFilterTag] = useState("");

  // Manual scan — the only thing that spends Helius credits
  const scan = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch(`/api/scanner?refresh=1`);
      const d = await r.json();
      setWallets(d.wallets || []);
      setMeta(d);
      setLastScan(new Date());
    } finally {
      setLoading(false);
    }
  }, []);

  // On page load: show cached results only, zero Helius requests
  useEffect(() => {
    (async () => {
      try {
        const r = await fetch(`/api/scanner?mode=cached`);
        const d = await r.json();
        setWallets(d.wallets || []);
        setMeta(d);
        if (d.lastScanTs) setLastScan(new Date(d.lastScanTs));
      } catch { /* ignore */ }
    })();
  }, []);

  function copyAddr(addr: string) {
    navigator.clipboard?.writeText(addr);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
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
            <h1 className="text-2xl font-bold text-white flex items-center gap-2">🧠 Smart Money Scanner</h1>
            <p className="text-slate-500 text-sm mt-1">
              Находит кошельки с PnL &gt; 0 и Win Rate ≥ 60% на Solana DEX
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
              onClick={scan}
              disabled={loading}
              className="px-4 py-2 bg-emerald-500 hover:bg-emerald-400 disabled:opacity-50 text-black font-semibold rounded-xl text-sm transition-all flex items-center gap-2"
            >
              {loading ? (
                <><span className="w-4 h-4 border-2 border-black/30 border-t-black rounded-full animate-spin" />Сканирую...</>
              ) : (<>🔍 Сканировать</>)}
            </button>
          </div>
        </div>

        {/* Scan report */}
        {meta && !meta.cached && meta.heliusRequests !== undefined && (
          <div className="bg-[#0d1117] border border-slate-800 rounded-xl p-3 mb-4">
            <div className="text-xs text-slate-500 font-medium uppercase tracking-wide mb-2">Отчёт сканирования</div>
            <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 text-sm">
              <div><span className="text-slate-500">Пар просканировано: </span><span className="text-white font-semibold">{meta.scannedPairs}</span></div>
              <div><span className="text-slate-500">Кошельков проверено: </span><span className="text-white font-semibold">{meta.scannedWallets}</span></div>
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
          <div className="space-y-2">
            {displayed.map((w) => (
              <WalletRow key={w.address} wallet={w} onCopy={copyAddr} />
            ))}
          </div>
        )}

        <p className="text-xs text-slate-600 text-center mt-6">
          Нажми на кошелёк для детальной статистики · Сканирование запускается только вручную (~30-35 запросов Helius за скан)
        </p>
      </main>
    </div>
  );
}
