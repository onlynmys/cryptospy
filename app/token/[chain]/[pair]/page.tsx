"use client";

import { useState, useEffect, useCallback, use } from "react";
import Link from "next/link";
import Navbar from "@/components/Navbar";
import WalletCard from "@/components/WalletCard";

interface PageProps {
  params: Promise<{ chain: string; pair: string }>;
}

function explorerUrl(address: string, chain: string): string | null {
  const isEvm = address.startsWith("0x") && address.length === 42;
  const isSolana = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address) && !address.startsWith("0x");

  if (isEvm) {
    const map: Record<string, string> = {
      ethereum: `https://etherscan.io/address/${address}`,
      bsc: `https://bscscan.com/address/${address}`,
      base: `https://basescan.org/address/${address}`,
      arbitrum: `https://arbiscan.io/address/${address}`,
      polygon: `https://polygonscan.com/address/${address}`,
    };
    return map[chain] || `https://etherscan.io/address/${address}`;
  }

  if (isSolana || chain === "solana") {
    return `https://solscan.io/account/${address}`;
  }

  return null;
}

function ExplorerLink({ address, chain }: { address: string; chain: string }) {
  const url = explorerUrl(address, chain);

  if (!url) {
    return (
      <div className="w-full text-center py-2 text-slate-600 text-xs">
        Нет ссылки на эксплорер для этого адреса
      </div>
    );
  }

  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className="block w-full text-center py-2 bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 rounded-xl text-sm hover:bg-emerald-500/20 transition-colors"
    >
      ↗ Открыть в эксплорере
    </a>
  );
}

type Wallet = {
  address: string;
  shortAddress: string;
  winRate: number;
  totalTrades: number;
  totalPnlUsd: number;
  avgBuyUsd: number;
  lastActivity: number;
  score: number;
  tags: string[];
};

interface PairData {
  baseToken: { symbol: string; name: string; address: string };
  quoteToken: { symbol: string };
  priceUsd?: string;
  priceChange?: { h1?: number; h24?: number; m5?: number; h6?: number };
  volume?: { h24?: number; h1?: number; m5?: number };
  liquidity?: { usd?: number };
  txns?: {
    h24?: { buys?: number; sells?: number };
    h1?: { buys?: number; sells?: number };
    m5?: { buys?: number; sells?: number };
  };
  pairCreatedAt?: number;
  fdv?: number;
  marketCap?: number;
  dexId?: string;
  info?: { imageUrl?: string; websites?: { url: string }[]; socials?: { type: string; url: string }[] };
}

function fmt(n: number | undefined): string {
  if (!n) return "—";
  if (n >= 1_000_000) return "$" + (n / 1_000_000).toFixed(2) + "M";
  if (n >= 1_000) return "$" + (n / 1_000).toFixed(1) + "K";
  return "$" + n.toFixed(0);
}

function fmtPrice(p: string | undefined): string {
  if (!p) return "—";
  const n = parseFloat(p);
  if (n === 0) return "$0";
  if (n < 0.000001) return "$" + n.toExponential(3);
  if (n < 0.001) return "$" + n.toFixed(7);
  if (n < 1) return "$" + n.toFixed(5);
  return "$" + n.toFixed(4);
}

function PctBadge({ val }: { val?: number }) {
  if (val === undefined) return <span className="text-slate-500">—</span>;
  const up = val >= 0;
  return (
    <span className={`font-semibold ${up ? "text-emerald-400" : "text-red-400"}`}>
      {up ? "+" : ""}{val.toFixed(2)}%
    </span>
  );
}

export default function TokenPage({ params }: PageProps) {
  const { chain, pair } = use(params);

  const [pairData, setPairData] = useState<PairData | null>(null);
  const [wallets, setWallets] = useState<Wallet[]>([]);
  const [walletMeta, setWalletMeta] = useState<{ real: boolean; hasApiKey: boolean; message?: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [walletLoading, setWalletLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<"wallets" | "info">("wallets");
  const [selectedWallet, setSelectedWallet] = useState<Wallet | null>(null);

  const fetchData = useCallback(async () => {
    try {
      const r = await fetch(`/api/token?chain=${chain}&pair=${pair}`);
      const d = await r.json();
      if (d.pair) setPairData(d.pair);
    } finally {
      setLoading(false);
    }
  }, [chain, pair]);

  const fetchWallets = useCallback(async () => {
    setWalletLoading(true);
    try {
      const r = await fetch(`/api/wallets?chain=${chain}&pair=${pair}`);
      const d = await r.json();
      setWallets(d.wallets || []);
      setWalletMeta({ real: d.real ?? false, hasApiKey: d.hasApiKey ?? false, message: d.message });
    } finally {
      setWalletLoading(false);
    }
  }, [chain, pair]);

  useEffect(() => {
    fetchData();
    fetchWallets();
    const interval = setInterval(() => {
      fetchData();
      fetchWallets();
    }, 30000);
    return () => clearInterval(interval);
  }, [fetchData, fetchWallets]);

  if (loading) {
    return (
      <div className="min-h-screen">
        <Navbar />
        <div className="flex items-center justify-center h-64">
          <div className="text-slate-500">Loading token data...</div>
        </div>
      </div>
    );
  }

  if (!pairData) {
    return (
      <div className="min-h-screen">
        <Navbar />
        <div className="flex flex-col items-center justify-center h-64 gap-4">
          <div className="text-slate-500">Token not found</div>
          <Link href="/" className="text-emerald-400 hover:underline">← Back to market</Link>
        </div>
      </div>
    );
  }

  const p = pairData;
  const h24txns = p.txns?.h24;
  const totalTxns = (h24txns?.buys || 0) + (h24txns?.sells || 0);
  const buyPct = totalTxns > 0 ? Math.round(((h24txns?.buys || 0) / totalTxns) * 100) : 50;

  return (
    <div className="min-h-screen">
      <Navbar />
      <main className="max-w-7xl mx-auto px-4 py-6">
        {/* Breadcrumb */}
        <div className="flex items-center gap-2 text-sm text-slate-500 mb-4">
          <Link href="/" className="hover:text-slate-300 transition-colors">Market</Link>
          <span>/</span>
          <span className="text-slate-300">{p.baseToken.symbol}/{p.quoteToken.symbol}</span>
        </div>

        {/* Token header */}
        <div className="bg-[#0d1117] border border-slate-800 rounded-2xl p-6 mb-6">
          <div className="flex flex-col sm:flex-row sm:items-start gap-4">
            <div className="flex items-center gap-4">
              {p.info?.imageUrl ? (
                <img src={p.info.imageUrl} alt="" className="w-14 h-14 rounded-full bg-slate-800" />
              ) : (
                <div className="w-14 h-14 rounded-full bg-gradient-to-br from-emerald-400/20 to-blue-500/20 flex items-center justify-center text-xl font-bold">
                  {p.baseToken.symbol.slice(0, 2)}
                </div>
              )}
              <div>
                <h1 className="text-2xl font-bold text-white">
                  {p.baseToken.symbol}
                  <span className="text-slate-500 text-lg font-normal ml-2">/{p.quoteToken.symbol}</span>
                </h1>
                <div className="text-slate-500 text-sm">{p.baseToken.name}</div>
                <div className="flex items-center gap-2 mt-1">
                  <span className="text-xs bg-slate-800 text-slate-400 px-2 py-0.5 rounded">
                    {chain.toUpperCase()}
                  </span>
                  {p.dexId && (
                    <span className="text-xs bg-slate-800 text-slate-400 px-2 py-0.5 rounded">
                      {p.dexId}
                    </span>
                  )}
                </div>
              </div>
            </div>

            <div className="sm:ml-auto flex flex-col items-start sm:items-end gap-1">
              <div className="text-3xl font-mono font-bold text-white">{fmtPrice(p.priceUsd)}</div>
              <div className="flex gap-3 text-sm">
                <span><PctBadge val={p.priceChange?.m5} /> 5m</span>
                <span><PctBadge val={p.priceChange?.h1} /> 1h</span>
                <span><PctBadge val={p.priceChange?.h24} /> 24h</span>
              </div>
            </div>
          </div>

          {/* Metrics grid */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-6">
            {[
              { label: "Volume 24h", value: fmt(p.volume?.h24) },
              { label: "Liquidity", value: fmt(p.liquidity?.usd) },
              { label: "FDV", value: fmt(p.fdv) },
              { label: "Market Cap", value: fmt(p.marketCap) },
            ].map((m) => (
              <div key={m.label} className="bg-slate-800/40 rounded-xl p-3">
                <div className="text-xs text-slate-500 mb-1">{m.label}</div>
                <div className="font-semibold text-white">{m.value}</div>
              </div>
            ))}
          </div>

          {/* Buy/Sell pressure */}
          {totalTxns > 0 && (
            <div className="mt-4">
              <div className="flex justify-between text-sm mb-2">
                <span className="text-emerald-400 font-medium">
                  ▲ {h24txns?.buys || 0} Buys ({buyPct}%)
                </span>
                <span className="text-red-400 font-medium">
                  ▼ {h24txns?.sells || 0} Sells ({100 - buyPct}%)
                </span>
              </div>
              <div className="h-2 bg-red-500/40 rounded-full overflow-hidden">
                <div
                  className="h-full bg-gradient-to-r from-emerald-500 to-emerald-400 rounded-full transition-all"
                  style={{ width: `${buyPct}%` }}
                />
              </div>
            </div>
          )}

          {/* External links */}
          <div className="flex gap-2 mt-4">
            <a
              href={`https://dexscreener.com/${chain}/${pair}`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg transition-colors"
            >
              ↗ DEX Screener
            </a>
            {p.info?.websites?.[0] && (
              <a
                href={p.info.websites[0].url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg transition-colors"
              >
                ↗ Website
              </a>
            )}
          </div>
        </div>

        {/* Tabs */}
        <div className="flex gap-1 bg-[#0d1117] border border-slate-800 rounded-xl p-1 mb-5 w-fit">
          {(["wallets", "info"] as const).map((tab) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={`px-4 py-2 rounded-lg text-sm font-medium transition-all capitalize ${
                activeTab === tab
                  ? "bg-emerald-500 text-black"
                  : "text-slate-400 hover:text-white"
              }`}
            >
              {tab === "wallets" ? "🧠 Smart Wallets" : "ℹ️ Token Info"}
            </button>
          ))}
        </div>

        {activeTab === "wallets" && (
          <div>
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-semibold text-white">
                Трейдеры на этой паре
              </h2>
              {walletMeta && wallets.length > 0 && (
                <span className={`text-xs px-2 py-1 rounded font-medium ${
                  walletMeta.real
                    ? "bg-emerald-500/10 text-emerald-400 border border-emerald-500/20"
                    : "bg-slate-800 text-slate-500"
                }`}>
                  {walletMeta.real ? "✓ Реальные on-chain данные" : "Нет данных"}
                </span>
              )}
            </div>

            {walletLoading ? (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                {Array.from({ length: 6 }).map((_, i) => (
                  <div key={i} className="bg-[#0d1117] border border-slate-800 rounded-xl p-4 animate-pulse">
                    <div className="h-4 bg-slate-800 rounded w-32 mb-3" />
                    <div className="grid grid-cols-3 gap-2">
                      {[0, 1, 2].map((j) => (
                        <div key={j} className="bg-slate-800 rounded-lg h-14" />
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            ) : wallets.length === 0 ? (
              <div className="flex flex-col items-center py-16 gap-4">
                <div className="text-4xl">🔍</div>
                <div className="text-slate-300 font-medium text-lg text-center">
                  {walletMeta?.message || "Нет данных о трейдерах"}
                </div>
                {!walletMeta?.hasApiKey && chain === "solana" && (
                  <div className="flex flex-col items-center gap-3">
                    <p className="text-slate-500 text-sm text-center max-w-sm">
                      Для анализа реальных кошельков которые торговали этим токеном нужен Helius API ключ
                    </p>
                    <div className="flex gap-2">
                      <a
                        href="https://helius.dev"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="px-4 py-2 bg-emerald-500 text-black font-semibold rounded-xl text-sm hover:bg-emerald-400 transition-colors"
                      >
                        Получить ключ бесплатно →
                      </a>
                      <Link
                        href="/settings"
                        className="px-4 py-2 border border-slate-700 text-slate-300 rounded-xl text-sm hover:border-slate-500 transition-colors"
                      >
                        Настройки
                      </Link>
                    </div>
                  </div>
                )}
                {chain !== "solana" && (
                  <p className="text-slate-500 text-sm text-center max-w-sm">
                    Анализ кошельков сейчас доступен только для Solana токенов
                  </p>
                )}
              </div>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                {wallets.map((w, i) => (
                  <WalletCard
                    key={w.address}
                    wallet={w}
                    rank={i}
                    onClick={() => setSelectedWallet(w)}
                  />
                ))}
              </div>
            )}
          </div>
        )}

        {activeTab === "info" && (
          <div className="bg-[#0d1117] border border-slate-800 rounded-xl p-5">
            <h2 className="text-lg font-semibold text-white mb-4">Token Information</h2>
            <div className="space-y-3">
              <div className="flex justify-between py-2 border-b border-slate-800">
                <span className="text-slate-500">Name</span>
                <span className="text-slate-200">{p.baseToken.name}</span>
              </div>
              <div className="flex justify-between py-2 border-b border-slate-800">
                <span className="text-slate-500">Symbol</span>
                <span className="text-slate-200">{p.baseToken.symbol}</span>
              </div>
              <div className="flex justify-between py-2 border-b border-slate-800">
                <span className="text-slate-500">Chain</span>
                <span className="text-slate-200 capitalize">{chain}</span>
              </div>
              <div className="flex justify-between py-2 border-b border-slate-800">
                <span className="text-slate-500">Contract</span>
                <span className="text-slate-200 font-mono text-xs break-all text-right ml-4">
                  {p.baseToken.address}
                </span>
              </div>
              {p.pairCreatedAt && (
                <div className="flex justify-between py-2 border-b border-slate-800">
                  <span className="text-slate-500">Pair Created</span>
                  <span className="text-slate-200">
                    {new Date(p.pairCreatedAt).toLocaleDateString()}
                  </span>
                </div>
              )}
              <div className="flex justify-between py-2">
                <span className="text-slate-500">Pair Address</span>
                <span className="text-slate-200 font-mono text-xs break-all text-right ml-4">
                  {pair}
                </span>
              </div>
            </div>
          </div>
        )}

        {/* Wallet detail modal */}
        {selectedWallet && (
          <div
            className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-center justify-center p-4"
            onClick={() => setSelectedWallet(null)}
          >
            <div
              className="bg-[#0d1117] border border-slate-700 rounded-2xl p-6 max-w-md w-full"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-center justify-between mb-5">
                <h3 className="text-lg font-bold text-white">Wallet Details</h3>
                <button onClick={() => setSelectedWallet(null)} className="text-slate-500 hover:text-white">✕</button>
              </div>

              <div className="font-mono text-sm text-slate-400 mb-4 bg-slate-800/50 px-3 py-2 rounded-lg flex items-center justify-between">
                <span className="truncate">{selectedWallet.address}</span>
                <button
                  onClick={() => navigator.clipboard?.writeText(selectedWallet.address)}
                  className="ml-2 text-emerald-400 hover:text-emerald-300 shrink-0"
                >
                  ⎘
                </button>
              </div>

              <div className="grid grid-cols-3 gap-3 mb-4">
                {[
                  { label: "Win Rate", value: selectedWallet.winRate.toFixed(1) + "%", color: "text-emerald-400" },
                  { label: "Score", value: selectedWallet.score.toString(), color: "text-yellow-400" },
                  { label: "Trades", value: selectedWallet.totalTrades.toString(), color: "text-blue-400" },
                ].map((s) => (
                  <div key={s.label} className="bg-slate-800/50 rounded-xl p-3 text-center">
                    <div className={`text-xl font-bold ${s.color}`}>{s.value}</div>
                    <div className="text-xs text-slate-500">{s.label}</div>
                  </div>
                ))}
              </div>

              <div className="space-y-2 mb-4">
                {[
                  { label: "Total PnL", value: (selectedWallet.totalPnlUsd >= 0 ? "+" : "") + "$" + Math.abs(selectedWallet.totalPnlUsd).toLocaleString() },
                  { label: "Avg Buy Size", value: "$" + selectedWallet.avgBuyUsd.toLocaleString() },
                ].map((r) => (
                  <div key={r.label} className="flex justify-between text-sm">
                    <span className="text-slate-500">{r.label}</span>
                    <span className="text-slate-200">{r.value}</span>
                  </div>
                ))}
              </div>

              <div className="flex flex-wrap gap-1 mb-4">
                {selectedWallet.tags.map((tag) => (
                  <span key={tag} className="text-xs bg-slate-800 text-slate-300 px-2 py-1 rounded-lg">{tag}</span>
                ))}
              </div>

              <ExplorerLink address={selectedWallet.address} chain={chain} />
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
