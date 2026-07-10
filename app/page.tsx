"use client";

import { useState, useEffect, useCallback } from "react";
import Navbar from "@/components/Navbar";
import TokenCard from "@/components/TokenCard";

const CHAINS = [
  { id: "", label: "All" },
  { id: "solana", label: "Solana" },
  { id: "ethereum", label: "Ethereum" },
  { id: "bsc", label: "BSC" },
  { id: "base", label: "Base" },
  { id: "arbitrum", label: "Arbitrum" },
];

const MODES = [
  { id: "trending", label: "🔥 Trending" },
  { id: "boosted", label: "🚀 Boosted" },
];

type Pair = Parameters<typeof TokenCard>[0]["pair"];

export default function HomePage() {
  const [chain, setChain] = useState("");
  const [mode, setMode] = useState("trending");
  const [pairs, setPairs] = useState<Pair[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [searchResults, setSearchResults] = useState<Pair[]>([]);
  const [searching, setSearching] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  const fetchTrending = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch(`/api/trending?chain=${chain}&mode=${mode}`);
      const d = await r.json();
      setPairs(d.pairs || []);
      setLastUpdated(new Date());
    } finally {
      setLoading(false);
    }
  }, [chain, mode]);

  useEffect(() => {
    if (!search) {
      fetchTrending();
      const interval = setInterval(fetchTrending, 60000);
      return () => clearInterval(interval);
    }
  }, [fetchTrending, search]);

  useEffect(() => {
    if (!search.trim()) {
      setSearchResults([]);
      return;
    }
    const timer = setTimeout(async () => {
      setSearching(true);
      try {
        const r = await fetch(`/api/token?q=${encodeURIComponent(search)}`);
        const d = await r.json();
        setSearchResults(d.pairs || []);
      } finally {
        setSearching(false);
      }
    }, 400);
    return () => clearTimeout(timer);
  }, [search]);

  const displayed = search ? searchResults : pairs;

  return (
    <div className="min-h-screen">
      <Navbar />

      <main className="max-w-7xl mx-auto px-4 py-6">
        {/* Header */}
        <div className="mb-6">
          <h1 className="text-2xl font-bold text-white mb-1">DEX Market Overview</h1>
          <p className="text-slate-500 text-sm">
            Real-time data from DEX Screener across all major chains
            {lastUpdated && (
              <span className="ml-2 text-slate-600">
                · Updated {lastUpdated.toLocaleTimeString()}
              </span>
            )}
          </p>
        </div>

        {/* Search */}
        <div className="relative mb-5">
          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500">🔍</span>
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search token name or address..."
            className="w-full bg-[#0d1117] border border-slate-700 rounded-xl pl-10 pr-4 py-3 text-slate-200 placeholder-slate-600 focus:outline-none focus:border-emerald-500/50 focus:ring-1 focus:ring-emerald-500/20 transition-all"
          />
          {searching && (
            <span className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 text-xs">
              Loading...
            </span>
          )}
        </div>

        {/* Filters */}
        {!search && (
          <div className="flex flex-col sm:flex-row gap-3 mb-6 flex-wrap">
            <div className="flex gap-1 bg-[#0d1117] border border-slate-800 rounded-xl p-1">
              {MODES.map((m) => (
                <button
                  key={m.id}
                  onClick={() => setMode(m.id)}
                  className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-all ${
                    mode === m.id
                      ? "bg-emerald-500 text-black"
                      : "text-slate-400 hover:text-white"
                  }`}
                >
                  {m.label}
                </button>
              ))}
            </div>

            <div className="flex gap-1 bg-[#0d1117] border border-slate-800 rounded-xl p-1 flex-wrap">
              {CHAINS.map((c) => (
                <button
                  key={c.id}
                  onClick={() => setChain(c.id)}
                  className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-all ${
                    chain === c.id
                      ? "bg-slate-700 text-white"
                      : "text-slate-500 hover:text-slate-300"
                  }`}
                >
                  {c.label}
                </button>
              ))}
            </div>

            <button
              onClick={fetchTrending}
              className="ml-auto px-4 py-2 rounded-xl border border-slate-700 text-slate-400 hover:text-white hover:border-slate-500 text-sm transition-all"
            >
              ↻ Refresh
            </button>
          </div>
        )}

        {/* Stats bar */}
        {!search && !loading && pairs.length > 0 && (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
            {[
              { label: "Tokens shown", value: pairs.length.toString(), color: "text-white" },
              {
                label: "Gainers (24h)",
                value: pairs.filter((p) => (p.priceChange?.h24 ?? 0) > 0).length.toString(),
                color: "text-emerald-400",
              },
              {
                label: "Losers (24h)",
                value: pairs.filter((p) => (p.priceChange?.h24 ?? 0) < 0).length.toString(),
                color: "text-red-400",
              },
              {
                label: "Total Volume",
                value:
                  "$" +
                  (pairs.reduce((s, p) => s + (p.volume?.h24 || 0), 0) / 1_000_000).toFixed(1) +
                  "M",
                color: "text-blue-400",
              },
            ].map((s) => (
              <div key={s.label} className="bg-[#0d1117] border border-slate-800 rounded-xl p-3">
                <div className={`text-xl font-bold ${s.color}`}>{s.value}</div>
                <div className="text-xs text-slate-500 mt-0.5">{s.label}</div>
              </div>
            ))}
          </div>
        )}

        {/* Token grid */}
        {loading && !search ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
            {Array.from({ length: 12 }).map((_, i) => (
              <div key={i} className="bg-[#0d1117] border border-slate-800 rounded-xl p-4 animate-pulse">
                <div className="flex gap-2 mb-3">
                  <div className="w-8 h-8 bg-slate-800 rounded-full" />
                  <div className="flex-1">
                    <div className="h-4 bg-slate-800 rounded w-20 mb-1" />
                    <div className="h-3 bg-slate-800 rounded w-28" />
                  </div>
                </div>
                <div className="h-6 bg-slate-800 rounded w-24 mb-2" />
                <div className="h-4 bg-slate-800 rounded w-16" />
              </div>
            ))}
          </div>
        ) : displayed.length === 0 ? (
          <div className="text-center py-20 text-slate-500">
            {search ? "No results found" : "No tokens found. Try refreshing."}
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
            {displayed.map((p) => (
              <TokenCard key={p.pairAddress + p.chainId} pair={p} />
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
