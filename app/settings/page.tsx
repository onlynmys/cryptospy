"use client";

import { useState, useEffect } from "react";
import Navbar from "@/components/Navbar";

interface Settings {
  heliusApiKey: string;
  minWinRate: number;
  minTradeSize: number;
  alertsEnabled: boolean;
  chains: string[];
  theme: "dark";
}

const DEFAULT: Settings = {
  heliusApiKey: "",
  minWinRate: 70,
  minTradeSize: 500,
  alertsEnabled: true,
  chains: ["solana", "ethereum", "bsc", "base"],
  theme: "dark",
};

const CHAINS = [
  { id: "solana", label: "Solana", color: "text-purple-400" },
  { id: "ethereum", label: "Ethereum", color: "text-blue-400" },
  { id: "bsc", label: "BSC", color: "text-yellow-400" },
  { id: "base", label: "Base", color: "text-blue-300" },
  { id: "arbitrum", label: "Arbitrum", color: "text-sky-400" },
  { id: "polygon", label: "Polygon", color: "text-violet-400" },
];

export default function SettingsPage() {
  const [settings, setSettings] = useState<Settings>(DEFAULT);
  const [saved, setSaved] = useState(false);
  const [showKey, setShowKey] = useState(false);

  useEffect(() => {
    const stored = localStorage.getItem("cryptospy_settings");
    if (stored) {
      try { setSettings({ ...DEFAULT, ...JSON.parse(stored) }); } catch {}
    }
  }, []);

  function save() {
    localStorage.setItem("cryptospy_settings", JSON.stringify(settings));
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }

  function toggleChain(id: string) {
    setSettings((s) => ({
      ...s,
      chains: s.chains.includes(id) ? s.chains.filter((c) => c !== id) : [...s.chains, id],
    }));
  }

  return (
    <div className="min-h-screen">
      <Navbar />
      <main className="max-w-2xl mx-auto px-4 py-6">
        <div className="mb-6">
          <h1 className="text-2xl font-bold text-white mb-1">Settings</h1>
          <p className="text-slate-500 text-sm">Configure your CryptoSpy tracker</p>
        </div>

        <div className="space-y-4">
          {/* API Keys */}
          <div className="bg-[#0d1117] border border-slate-800 rounded-xl p-5">
            <h2 className="text-base font-semibold text-white mb-1">API Keys</h2>
            <p className="text-xs text-slate-500 mb-4">
              Connect API keys for real on-chain wallet data (optional — app works without them)
            </p>

            <div className="space-y-4">
              <div>
                <label className="block text-sm text-slate-400 mb-1.5">
                  Helius API Key <span className="text-slate-600">(Solana wallet history)</span>
                </label>
                <div className="relative">
                  <input
                    type={showKey ? "text" : "password"}
                    value={settings.heliusApiKey}
                    onChange={(e) => setSettings((s) => ({ ...s, heliusApiKey: e.target.value }))}
                    placeholder="Enter Helius API key..."
                    className="w-full bg-slate-800/50 border border-slate-700 rounded-xl px-4 py-2.5 text-slate-200 placeholder-slate-600 focus:outline-none focus:border-emerald-500/50 text-sm pr-12"
                  />
                  <button
                    onClick={() => setShowKey(!showKey)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300"
                  >
                    {showKey ? "👁" : "🔒"}
                  </button>
                </div>
                <p className="text-xs text-slate-600 mt-1">
                  Get a free key at helius.dev — free tier gives 1M credits/month
                </p>
              </div>
            </div>
          </div>

          {/* Smart Wallet Filters */}
          <div className="bg-[#0d1117] border border-slate-800 rounded-xl p-5">
            <h2 className="text-base font-semibold text-white mb-4">Smart Wallet Filters</h2>

            <div className="space-y-4">
              <div>
                <div className="flex justify-between mb-2">
                  <label className="text-sm text-slate-400">Min Win Rate</label>
                  <span className="text-sm font-semibold text-emerald-400">{settings.minWinRate}%</span>
                </div>
                <input
                  type="range"
                  min={50}
                  max={95}
                  step={5}
                  value={settings.minWinRate}
                  onChange={(e) => setSettings((s) => ({ ...s, minWinRate: +e.target.value }))}
                  className="w-full accent-emerald-500"
                />
                <div className="flex justify-between text-xs text-slate-600 mt-1">
                  <span>50%</span><span>70%</span><span>95%</span>
                </div>
              </div>

              <div>
                <div className="flex justify-between mb-2">
                  <label className="text-sm text-slate-400">Min Trade Size (USD)</label>
                  <span className="text-sm font-semibold text-emerald-400">${settings.minTradeSize.toLocaleString()}</span>
                </div>
                <input
                  type="range"
                  min={100}
                  max={10000}
                  step={100}
                  value={settings.minTradeSize}
                  onChange={(e) => setSettings((s) => ({ ...s, minTradeSize: +e.target.value }))}
                  className="w-full accent-emerald-500"
                />
                <div className="flex justify-between text-xs text-slate-600 mt-1">
                  <span>$100</span><span>$5K</span><span>$10K</span>
                </div>
              </div>
            </div>
          </div>

          {/* Chains */}
          <div className="bg-[#0d1117] border border-slate-800 rounded-xl p-5">
            <h2 className="text-base font-semibold text-white mb-4">Active Chains</h2>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
              {CHAINS.map((c) => (
                <button
                  key={c.id}
                  onClick={() => toggleChain(c.id)}
                  className={`flex items-center gap-2 px-3 py-2.5 rounded-xl border text-sm font-medium transition-all ${
                    settings.chains.includes(c.id)
                      ? "border-emerald-500/40 bg-emerald-500/10 text-white"
                      : "border-slate-800 text-slate-500 hover:border-slate-700"
                  }`}
                >
                  <span className={`w-2 h-2 rounded-full ${settings.chains.includes(c.id) ? "bg-emerald-400" : "bg-slate-700"}`} />
                  <span className={settings.chains.includes(c.id) ? c.color : ""}>{c.label}</span>
                </button>
              ))}
            </div>
          </div>

          {/* Alerts */}
          <div className="bg-[#0d1117] border border-slate-800 rounded-xl p-5">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-base font-semibold text-white">Live Alerts</h2>
                <p className="text-xs text-slate-500 mt-0.5">Show real-time notifications for smart wallet moves</p>
              </div>
              <button
                onClick={() => setSettings((s) => ({ ...s, alertsEnabled: !s.alertsEnabled }))}
                className={`relative w-12 h-6 rounded-full transition-colors ${settings.alertsEnabled ? "bg-emerald-500" : "bg-slate-700"}`}
              >
                <span className={`absolute top-1 w-4 h-4 bg-white rounded-full transition-all ${settings.alertsEnabled ? "left-7" : "left-1"}`} />
              </button>
            </div>
          </div>

          {/* Save */}
          <button
            onClick={save}
            className={`w-full py-3 rounded-xl font-semibold text-sm transition-all ${
              saved
                ? "bg-emerald-500/20 text-emerald-400 border border-emerald-500/40"
                : "bg-emerald-500 text-black hover:bg-emerald-400"
            }`}
          >
            {saved ? "✓ Saved!" : "Save Settings"}
          </button>
        </div>

        <div className="mt-8 p-4 bg-slate-800/30 border border-slate-800 rounded-xl text-xs text-slate-600">
          <p className="font-medium text-slate-500 mb-2">About data sources</p>
          <ul className="space-y-1">
            <li>• <strong className="text-slate-400">DEX Screener API</strong> — free, no key needed. Provides token prices, volumes, and pair data.</li>
            <li>• <strong className="text-slate-400">Helius API</strong> — free tier (1M credits/month). Provides Solana wallet transaction history for real smart wallet analysis.</li>
            <li>• Without Helius key, wallet analysis uses estimated data based on pair trading patterns.</li>
          </ul>
        </div>
      </main>
    </div>
  );
}
