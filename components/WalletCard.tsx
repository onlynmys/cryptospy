"use client";

interface Wallet {
  address: string;
  shortAddress: string;
  winRate: number;
  totalTrades: number;
  totalPnlUsd: number;
  avgBuyUsd: number;
  lastActivity: number;
  score: number;
  tags: string[];
  buys?: number;
  sells?: number;
  totalBuyUsd?: number;
  totalSellUsd?: number;
}

interface Props {
  wallet: Wallet;
  rank?: number;
  onClick?: () => void;
}

function fmt(n: number): string {
  const abs = Math.abs(n);
  const sign = n < 0 ? "-" : n > 0 ? "+" : "";
  if (abs >= 1_000_000) return sign + "$" + (abs / 1_000_000).toFixed(1) + "M";
  if (abs >= 1_000) return sign + "$" + (abs / 1_000).toFixed(1) + "K";
  return sign + "$" + abs.toFixed(0);
}

function timeAgo(ts: number): string {
  const sec = Math.floor(Date.now() / 1000 - ts);
  if (sec < 60) return sec + "s ago";
  if (sec < 3600) return Math.floor(sec / 60) + "m ago";
  if (sec < 86400) return Math.floor(sec / 3600) + "h ago";
  return Math.floor(sec / 86400) + "d ago";
}

function scoreColor(s: number) {
  if (s >= 70) return "text-emerald-400 border-emerald-400/40 bg-emerald-400/10";
  if (s >= 50) return "text-yellow-400 border-yellow-400/40 bg-yellow-400/10";
  return "text-slate-400 border-slate-600 bg-slate-800/50";
}

export default function WalletCard({ wallet, rank, onClick }: Props) {
  const pnlPositive = wallet.totalPnlUsd >= 0;

  return (
    <div
      onClick={onClick}
      className="bg-[#0d1117] border border-slate-800 rounded-xl p-4 hover:border-slate-600 transition-all cursor-pointer group"
    >
      <div className="flex items-start justify-between mb-3">
        <div className="flex items-center gap-3">
          {rank !== undefined && (
            <span className="text-slate-500 text-sm font-mono w-5 shrink-0">#{rank + 1}</span>
          )}
          <div>
            <div className="font-mono text-sm text-slate-200 group-hover:text-white transition-colors">
              {wallet.shortAddress}
            </div>
            <div className="flex flex-wrap gap-1 mt-1">
              {wallet.tags.map((tag) => (
                <span key={tag} className="text-xs text-slate-400">{tag}</span>
              ))}
            </div>
          </div>
        </div>
        <div className={`text-sm font-bold px-2 py-1 rounded-lg border ${scoreColor(wallet.score)}`}>
          {wallet.score}
        </div>
      </div>

      <div className="grid grid-cols-3 gap-2 mb-3">
        <div className="bg-slate-800/40 rounded-lg p-2 text-center">
          <div className="text-lg font-bold text-white">{wallet.winRate.toFixed(1)}%</div>
          <div className="text-xs text-slate-500">Win Rate</div>
        </div>
        <div className="bg-slate-800/40 rounded-lg p-2 text-center">
          <div className={`text-lg font-bold ${pnlPositive ? "text-emerald-400" : "text-red-400"}`}>
            {fmt(wallet.totalPnlUsd)}
          </div>
          <div className="text-xs text-slate-500">PnL</div>
        </div>
        <div className="bg-slate-800/40 rounded-lg p-2 text-center">
          <div className="text-lg font-bold text-white">{wallet.totalTrades}</div>
          <div className="text-xs text-slate-500">Trades</div>
        </div>
      </div>

      {(wallet.buys !== undefined || wallet.totalBuyUsd !== undefined) && (
        <div className="flex items-center justify-between text-xs mb-2 bg-slate-800/30 rounded-lg px-2 py-1.5">
          <span className="text-emerald-400">
            ▲ {wallet.buys ?? 0} покуп.{wallet.totalBuyUsd ? ` (${fmt(wallet.totalBuyUsd)}$)` : ""}
          </span>
          <span className="text-red-400">
            ▼ {wallet.sells ?? 0} продаж{wallet.totalSellUsd ? ` (${fmt(wallet.totalSellUsd)}$)` : ""}
          </span>
        </div>
      )}

      <div className="flex items-center justify-between text-xs">
        <div className="text-slate-500">
          Avg buy: <span className="text-slate-300">${wallet.avgBuyUsd.toFixed(0)}</span>
        </div>
        <div className="text-slate-500">{timeAgo(wallet.lastActivity)}</div>
        <button
          onClick={(e) => {
            e.stopPropagation();
            navigator.clipboard?.writeText(wallet.address);
          }}
          className="text-slate-500 hover:text-emerald-400 transition-colors"
          title="Copy address"
        >
          ⎘
        </button>
      </div>

      <div className="mt-2">
        <div className="flex justify-between text-xs text-slate-600 mb-1">
          <span>Win rate</span>
          <span>{wallet.winRate.toFixed(1)}%</span>
        </div>
        <div className="h-1 bg-slate-800 rounded-full overflow-hidden">
          <div
            className="h-full bg-gradient-to-r from-emerald-500 to-emerald-400 rounded-full"
            style={{ width: `${Math.min(wallet.winRate, 100)}%` }}
          />
        </div>
      </div>
    </div>
  );
}
