"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import Navbar from "@/components/Navbar";

const SOLANA_ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const RECENT_KEY = "recent_wallet_checks";

function loadRecent(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

function timeAgo(ts: number): string {
  const sec = Math.floor(Date.now() / 1000 - ts);
  if (sec < 60) return "только что";
  if (sec < 3600) return Math.floor(sec / 60) + "м назад";
  if (sec < 86400) return Math.floor(sec / 3600) + "ч назад";
  return Math.floor(sec / 86400) + "д назад";
}

export default function WalletLookupPage() {
  const router = useRouter();
  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [recent, setRecent] = useState<{ address: string; ts: number }[]>([]);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(RECENT_KEY);
      setRecent(raw ? JSON.parse(raw) : []);
    } catch {}
  }, []);

  function go(address: string) {
    const addr = address.trim();
    if (!SOLANA_ADDRESS_RE.test(addr)) {
      setError("Похоже, это не Solana-адрес — проверь и вставь ещё раз");
      return;
    }
    const updated = [{ address: addr, ts: Date.now() / 1000 }, ...loadRecent().filter((r) => (typeof r === "string" ? r : r) !== addr)]
      .slice(0, 10);
    localStorage.setItem(RECENT_KEY, JSON.stringify(updated));
    router.push(`/wallet/${addr}`);
  }

  return (
    <div className="min-h-screen">
      <Navbar />
      <main className="max-w-2xl mx-auto px-4 py-16">
        <div className="text-center mb-8">
          <div className="text-4xl mb-3">🔍</div>
          <h1 className="text-2xl font-bold text-white mb-2">Проверить любой кошелёк</h1>
          <p className="text-slate-500 text-sm">
            Вставь адрес Solana-кошелька — покажем полную историю сделок, графики PnL и статистику.
            Данные читаются напрямую из блокчейна, без Helius.
          </p>
        </div>

        <div className="bg-[#0d1117] border border-slate-700 rounded-xl p-4 mb-6">
          <div className="flex gap-2">
            <input
              value={input}
              onChange={(e) => { setInput(e.target.value); setError(null); }}
              onKeyDown={(e) => e.key === "Enter" && go(input)}
              placeholder="Например: DCPPhmYVucS8XdCKtARsUy62uEDyY3DfQxjDNTdpe2Hs"
              autoFocus
              className="flex-1 bg-slate-800 border border-slate-600 rounded-xl px-4 py-3 text-slate-200 placeholder-slate-600 focus:outline-none focus:border-emerald-500 text-sm font-mono transition-colors"
            />
            <button
              onClick={() => go(input)}
              className="px-6 py-3 bg-emerald-500 hover:bg-emerald-400 text-black font-bold rounded-xl text-sm transition-all"
            >
              Проверить
            </button>
          </div>
          {error && <div className="text-xs text-red-400 mt-2">{error}</div>}
        </div>

        {recent.length > 0 && (
          <div>
            <div className="text-xs text-slate-500 font-medium uppercase tracking-wide mb-2">Недавно проверенные</div>
            <div className="bg-[#0d1117] border border-slate-800 rounded-xl divide-y divide-slate-800/50 overflow-hidden">
              {recent.map((r) => (
                <Link
                  key={r.address}
                  href={`/wallet/${r.address}`}
                  className="flex items-center justify-between px-4 py-3 hover:bg-slate-800/30 transition-colors"
                >
                  <span className="font-mono text-sm text-slate-300">
                    {r.address.slice(0, 10)}...{r.address.slice(-8)}
                  </span>
                  <span className="text-xs text-slate-600">{timeAgo(r.ts)}</span>
                </Link>
              ))}
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
