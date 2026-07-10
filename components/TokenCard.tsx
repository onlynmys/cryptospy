"use client";
import Link from "next/link";

interface Props {
  pair: {
    chainId: string;
    pairAddress: string;
    baseToken: { symbol: string; name: string; address: string };
    quoteToken: { symbol: string };
    priceUsd?: string;
    priceChange?: { h1?: number; h24?: number; m5?: number };
    volume?: { h24?: number; h1?: number };
    liquidity?: { usd?: number };
    txns?: { h24?: { buys?: number; sells?: number }; h1?: { buys?: number; sells?: number } };
    pairCreatedAt?: number;
    fdv?: number;
    info?: { imageUrl?: string };
  };
}

function fmt(n: number): string {
  if (n >= 1_000_000) return "$" + (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return "$" + (n / 1_000).toFixed(1) + "K";
  return "$" + n.toFixed(0);
}

function fmtPrice(p: string | undefined): string {
  if (!p) return "—";
  const n = parseFloat(p);
  if (n === 0) return "$0";
  if (n < 0.000001) return "$" + n.toExponential(2);
  if (n < 0.001) return "$" + n.toFixed(6);
  if (n < 1) return "$" + n.toFixed(4);
  return "$" + n.toFixed(2);
}

function ageLabel(createdAt: number | undefined): string {
  if (!createdAt) return "";
  const sec = Date.now() / 1000 - createdAt / 1000;
  if (sec < 3600) return Math.floor(sec / 60) + "m";
  if (sec < 86400) return Math.floor(sec / 3600) + "h";
  return Math.floor(sec / 86400) + "d";
}

function chainColor(chain: string) {
  const map: Record<string, string> = {
    solana: "text-purple-400 bg-purple-400/10",
    ethereum: "text-blue-400 bg-blue-400/10",
    bsc: "text-yellow-400 bg-yellow-400/10",
    base: "text-blue-300 bg-blue-300/10",
    arbitrum: "text-sky-400 bg-sky-400/10",
    polygon: "text-violet-400 bg-violet-400/10",
  };
  return map[chain] || "text-slate-400 bg-slate-400/10";
}

export default function TokenCard({ pair }: Props) {
  const change24 = pair.priceChange?.h24 ?? 0;
  const isUp = change24 >= 0;
  const vol24 = pair.volume?.h24 || 0;
  const liq = pair.liquidity?.usd || 0;
  const txH24 = pair.txns?.h24;
  const totalTxns = (txH24?.buys || 0) + (txH24?.sells || 0);
  const buyPct = totalTxns > 0 ? Math.round(((txH24?.buys || 0) / totalTxns) * 100) : 50;
  const age = ageLabel(pair.pairCreatedAt);

  return (
    <Link
      href={`/token/${pair.chainId}/${pair.pairAddress}`}
      className="block bg-[#0d1117] border border-slate-800 rounded-xl p-4 hover:border-slate-600 hover:bg-[#111827] transition-all group"
    >
      <div className="flex items-start justify-between mb-3">
        <div className="flex items-center gap-2 min-w-0">
          {pair.info?.imageUrl ? (
            <img
              src={pair.info.imageUrl}
              alt=""
              className="w-8 h-8 rounded-full shrink-0 bg-slate-800"
              onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
            />
          ) : (
            <div className="w-8 h-8 rounded-full bg-gradient-to-br from-emerald-400/20 to-blue-500/20 flex items-center justify-center text-xs font-bold shrink-0">
              {pair.baseToken.symbol.slice(0, 2)}
            </div>
          )}
          <div className="min-w-0">
            <div className="font-semibold text-white truncate">{pair.baseToken.symbol}</div>
            <div className="text-xs text-slate-500 truncate">{pair.baseToken.name}</div>
          </div>
        </div>
        <div className="flex flex-col items-end gap-1 shrink-0 ml-2">
          <span className={`text-xs px-1.5 py-0.5 rounded font-mono ${chainColor(pair.chainId)}`}>
            {pair.chainId.slice(0, 3).toUpperCase()}
          </span>
          {age && <span className="text-xs text-slate-500">{age} old</span>}
        </div>
      </div>

      <div className="flex items-end justify-between mb-3">
        <div>
          <div className="text-lg font-mono font-bold text-white">{fmtPrice(pair.priceUsd)}</div>
          <div className={`text-sm font-semibold ${isUp ? "text-emerald-400" : "text-red-400"}`}>
            {isUp ? "+" : ""}{change24.toFixed(2)}%
          </div>
        </div>
        <div className="text-right">
          <div className="text-xs text-slate-500">Vol 24h</div>
          <div className="text-sm font-semibold text-slate-200">{fmt(vol24)}</div>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2 mb-3 text-xs">
        <div className="bg-slate-800/50 rounded p-2">
          <div className="text-slate-500">Liquidity</div>
          <div className="text-slate-200 font-medium">{fmt(liq)}</div>
        </div>
        <div className="bg-slate-800/50 rounded p-2">
          <div className="text-slate-500">FDV</div>
          <div className="text-slate-200 font-medium">{pair.fdv ? fmt(pair.fdv) : "—"}</div>
        </div>
      </div>

      {totalTxns > 0 && (
        <div>
          <div className="flex justify-between text-xs text-slate-500 mb-1">
            <span className="text-emerald-400">▲ {txH24?.buys || 0} buys</span>
            <span className="text-red-400">{txH24?.sells || 0} sells ▼</span>
          </div>
          <div className="h-1.5 bg-red-500/40 rounded-full overflow-hidden">
            <div
              className="h-full bg-emerald-500 rounded-full transition-all"
              style={{ width: `${buyPct}%` }}
            />
          </div>
        </div>
      )}
    </Link>
  );
}
