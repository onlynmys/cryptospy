"use client";

import { useState, useEffect, useCallback } from "react";
import { createPortal } from "react-dom";
import SmartWalletRow, { timeAgo } from "@/components/SmartWalletRow";
import type { SmartWallet } from "@/lib/scannerCore";

interface DiscoveryRecord {
  address: string;
  firstSeen: number;
  lastSeen: number;
  wallet: SmartWallet;
}

const SEEN_KEY = "discoveries_seen";

export default function DiscoveriesBell() {
  const [records, setRecords] = useState<DiscoveryRecord[]>([]);
  const [seen, setSeen] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [unavailable, setUnavailable] = useState(false);
  const [copied, setCopied] = useState(false);
  const [mounted, setMounted] = useState(false);

  // document.body only exists client-side — portal target must wait for mount
  useEffect(() => setMounted(true), []);

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/discoveries", { cache: "no-store" });
      const d = await r.json();
      setRecords(d.discoveries || []);
      setUnavailable(!!d.unavailable);
    } catch {
      setUnavailable(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    try {
      const saved = localStorage.getItem(SEEN_KEY);
      if (saved) setSeen(new Set(JSON.parse(saved)));
    } catch { /* ignore */ }
    load();
    const interval = setInterval(load, 90_000);
    return () => clearInterval(interval);
  }, [load]);

  function copyAddr(addr: string) {
    navigator.clipboard?.writeText(addr);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  function closeModal() {
    setOpen(false);
    const next = new Set(seen);
    records.forEach((r) => next.add(r.address));
    setSeen(next);
    localStorage.setItem(SEEN_KEY, JSON.stringify(Array.from(next)));
  }

  const unseenCount = records.filter((r) => !seen.has(r.address)).length;

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="relative w-8 h-8 flex items-center justify-center rounded-lg hover:bg-slate-800 transition-colors"
        title="Автонаходки Smart Money"
      >
        <span className="text-lg">🔔</span>
        {unseenCount > 0 && (
          <span className="absolute -top-0.5 -right-0.5 min-w-[16px] h-4 px-1 rounded-full bg-emerald-500 text-black text-[10px] font-bold flex items-center justify-center">
            {unseenCount > 9 ? "9+" : unseenCount}
          </span>
        )}
      </button>

      {open && mounted && createPortal(
        <div
          className="fixed inset-0 bg-black/70 backdrop-blur-sm z-[100] flex items-start justify-center p-4 overflow-y-auto"
          onClick={closeModal}
        >
          {copied && (
            <div className="fixed top-16 right-4 z-[60] bg-emerald-500 text-black px-4 py-2 rounded-xl text-sm font-medium slide-in">
              ✓ Адрес скопирован
            </div>
          )}
          <div
            className="bg-[#0d1117] border border-slate-700 rounded-2xl w-full max-w-2xl max-h-[85vh] mt-8 flex flex-col overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between p-5 border-b border-slate-800 shrink-0">
              <div>
                <h3 className="text-lg font-bold text-white flex items-center gap-2">
                  🔔 Автонаходки Smart Money
                </h3>
                <p className="text-xs text-slate-500 mt-0.5">
                  Бот сканирует сеть каждые ~30 минут и находит кошельки, соответствующие строгому фильтру
                </p>
              </div>
              <button onClick={closeModal} className="text-slate-500 hover:text-white text-xl w-8 h-8 flex items-center justify-center shrink-0">✕</button>
            </div>

            <div className="flex-1 min-h-0 overflow-y-auto p-4">
              {loading ? (
                <div className="text-center py-16 text-slate-500">Загрузка...</div>
              ) : unavailable ? (
                <div className="text-center py-16 text-slate-500">
                  <div className="text-3xl mb-2">⚠️</div>
                  <div>Сервис автосканирования недоступен</div>
                  <div className="text-xs mt-1 text-slate-600">Проверь что discovery-server запущен</div>
                </div>
              ) : records.length === 0 ? (
                <div className="text-center py-16 text-slate-500">
                  <div className="text-3xl mb-2">🔍</div>
                  <div>Пока ничего не найдено</div>
                  <div className="text-xs mt-1 text-slate-600">Бот ищет кошельки, проходящие строгий фильтр — проверь настройки в Settings</div>
                </div>
              ) : (
                <div className="space-y-2">
                  {records.map((r) => (
                    <SmartWalletRow
                      key={r.address}
                      wallet={r.wallet}
                      onCopy={copyAddr}
                      extraBadge={`найден ${timeAgo(r.firstSeen / 1000)}`}
                    />
                  ))}
                </div>
              )}
            </div>

            <div className="px-5 py-3 border-t border-slate-800 text-xs text-slate-600 text-center shrink-0">
              Находки хранятся минимум 3 дня · Настроить пороги можно в Settings
            </div>
          </div>
        </div>,
        document.body
      )}
    </>
  );
}
