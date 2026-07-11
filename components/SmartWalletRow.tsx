"use client";

import { useState } from "react";
import Link from "next/link";
import type { SmartWallet, RecentBuy, TokenPositionInfo } from "@/lib/scannerCore";

export function timeAgo(ts: number): string {
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

export function fmtUsd(n: number, sign = false): string {
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

interface Props {
  wallet: SmartWallet;
  onCopy: (addr: string) => void;
  /** Optional extra badge shown next to the address, e.g. "найден 2ч назад" */
  extraBadge?: string;
  defaultExpanded?: boolean;
}

export default function SmartWalletRow({ wallet, onCopy, extraBadge, defaultExpanded }: Props) {
  const [expanded, setExpanded] = useState(!!defaultExpanded);
  const accountAge = wallet.firstActivity
    ? Math.max(1, Math.round((Date.now() / 1000 - wallet.firstActivity) / 86400))
    : null;

  return (
    <div className="border border-slate-800 rounded-xl overflow-hidden hover:border-slate-700 transition-all">
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
              {extraBadge && (
                <span className="text-xs bg-emerald-500/10 text-emerald-400 px-1.5 py-0.5 rounded">{extraBadge}</span>
              )}
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

      {expanded && (
        <div className="border-t border-slate-800 bg-slate-900/30">
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

          {wallet.recentBuys.length > 0 && (
            <>
              <div className="px-4 pt-2 pb-1 text-xs text-slate-500 font-medium uppercase tracking-wide flex items-center gap-2">
                <span className="w-1.5 h-1.5 bg-emerald-400 rounded-full animate-pulse" />
                Покупки за последние 24ч
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
                      {(buy.pairAddress || buy.tokenAddress) && (
                        <a
                          href={buy.pairAddress
                            ? `https://dexscreener.com/solana/${buy.pairAddress}`
                            : `https://dexscreener.com/solana/${buy.tokenAddress}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-xs text-slate-600 hover:text-emerald-400 transition-colors"
                          onClick={(e) => e.stopPropagation()}
                        >график →</a>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}

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

          <div className="flex gap-2 px-4 py-4 flex-wrap">
            <Link
              href={`/wallet/${wallet.address}`}
              onClick={(e) => e.stopPropagation()}
              className="text-xs px-3 py-1.5 bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 hover:bg-emerald-500/20 rounded-lg transition-colors font-medium"
            >📊 Полная история</Link>
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
