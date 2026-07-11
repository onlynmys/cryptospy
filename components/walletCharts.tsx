"use client";

// Hand-rolled chart primitives for the wallet detail page. The recharts-based
// first version rendered blank for users, and debugging a black-box library
// client-side is worse than owning ~200 lines of SVG/flexbox we can see
// through. Text lives in HTML (not SVG), so nothing stretches or overlaps.

import { useRef, useState } from "react";

const GREEN = "#34d399";
const RED = "#f87171";

export function fmtUsd(n: number): string {
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return sign + "$" + (abs / 1_000_000).toFixed(1) + "M";
  if (abs >= 1_000) return sign + "$" + (abs / 1_000).toFixed(1) + "K";
  return sign + "$" + abs.toFixed(abs < 10 && abs !== 0 ? 2 : 0);
}

function fmtDate(ts: number): string {
  return new Date(ts * 1000).toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit" });
}

function fmtDateTime(ts: number): string {
  return new Date(ts * 1000).toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

// ---------- cumulative PnL line ----------

export function PnlLineChart({ points }: { points: { ts: number; value: number }[] }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<number | null>(null);

  if (points.length === 0) {
    return <div className="h-52 flex items-center justify-center text-sm text-slate-600">Нет закрытых сделок в загруженном окне</div>;
  }

  // A single point can't make a line — pad with a zero start so the chart
  // still reads as "went from 0 to X".
  const pts = points.length === 1 ? [{ ts: points[0].ts - 3600, value: 0 }, ...points] : points;

  let min = Math.min(0, ...pts.map((p) => p.value));
  let max = Math.max(0, ...pts.map((p) => p.value));
  if (min === max) { min -= 1; max += 1; }
  const range = max - min;
  min -= range * 0.08;
  max += range * 0.08;

  const t0 = pts[0].ts;
  const t1 = pts[pts.length - 1].ts;
  const tSpan = Math.max(t1 - t0, 1);

  const X = (ts: number) => ((ts - t0) / tSpan) * 100;
  const Y = (v: number) => 100 - ((v - min) / (max - min)) * 100;

  const linePath = pts.map((p, i) => `${i === 0 ? "M" : "L"}${X(p.ts).toFixed(2)},${Y(p.value).toFixed(2)}`).join(" ");
  const areaPath = `${linePath} L100,100 L0,100 Z`;
  const zeroY = Y(0);
  const last = pts[pts.length - 1].value;
  const color = last >= 0 ? GREEN : RED;

  const hoverPt = hover !== null ? pts[hover] : null;

  function onMove(e: React.MouseEvent) {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const relX = ((e.clientX - rect.left) / rect.width) * 100;
    let bestIdx = 0;
    let bestDist = Infinity;
    pts.forEach((p, i) => {
      const d = Math.abs(X(p.ts) - relX);
      if (d < bestDist) { bestDist = d; bestIdx = i; }
    });
    setHover(bestIdx);
  }

  return (
    <div className="flex gap-2">
      {/* y labels live in HTML so they never stretch or collide with the plot */}
      <div className="flex flex-col justify-between text-right text-[11px] text-slate-500 py-0.5 w-14 shrink-0">
        <span>{fmtUsd(max)}</span>
        <span>{fmtUsd((max + min) / 2)}</span>
        <span>{fmtUsd(min)}</span>
      </div>
      <div className="flex-1 min-w-0">
        <div
          ref={containerRef}
          className="relative h-48 cursor-crosshair"
          onMouseMove={onMove}
          onMouseLeave={() => setHover(null)}
        >
          <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="absolute inset-0 w-full h-full">
            <defs>
              <linearGradient id="pnlFill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={color} stopOpacity="0.25" />
                <stop offset="100%" stopColor={color} stopOpacity="0.02" />
              </linearGradient>
            </defs>
            {[0, 25, 50, 75, 100].map((y) => (
              <line key={y} x1="0" y1={y} x2="100" y2={y} stroke="#1e293b" strokeWidth="1" vectorEffect="non-scaling-stroke" />
            ))}
            {zeroY >= 0 && zeroY <= 100 && (
              <line x1="0" y1={zeroY} x2="100" y2={zeroY} stroke="#475569" strokeWidth="1" strokeDasharray="4 3" vectorEffect="non-scaling-stroke" />
            )}
            <path d={areaPath} fill="url(#pnlFill)" />
            <path d={linePath} fill="none" stroke={color} strokeWidth="2" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
            {hoverPt && (
              <line x1={X(hoverPt.ts)} y1="0" x2={X(hoverPt.ts)} y2="100" stroke="#64748b" strokeWidth="1" strokeDasharray="3 3" vectorEffect="non-scaling-stroke" />
            )}
          </svg>
          {hoverPt && (
            <div
              className="absolute -top-1 -translate-x-1/2 bg-slate-900 border border-slate-700 rounded-lg px-2.5 py-1.5 text-xs pointer-events-none z-10 whitespace-nowrap shadow-xl"
              style={{ left: `${Math.min(Math.max(X(hoverPt.ts), 12), 88)}%` }}
            >
              <div className="text-slate-400">{fmtDateTime(hoverPt.ts)}</div>
              <div className={`font-bold ${hoverPt.value >= 0 ? "text-emerald-400" : "text-red-400"}`}>{fmtUsd(hoverPt.value)}</div>
            </div>
          )}
        </div>
        <div className="flex justify-between text-[11px] text-slate-600 mt-1">
          <span>{fmtDate(t0)}</span>
          {t1 - t0 > 86400 && <span>{fmtDate(t0 + tSpan / 2)}</span>}
          <span>{fmtDate(t1)}</span>
        </div>
      </div>
    </div>
  );
}

// ---------- daily buy/sell volume ----------

export function VolumeBars({ days }: { days: { day: string; buy: number; sell: number }[] }) {
  if (days.length === 0) {
    return <div className="h-52 flex items-center justify-center text-sm text-slate-600">Нет сделок в загруженном окне</div>;
  }
  const maxTotal = Math.max(...days.map((d) => d.buy + d.sell), 1);

  return (
    <div>
      <div className="flex items-end gap-[3px] h-44">
        {days.map((d) => {
          const buyH = (d.buy / maxTotal) * 100;
          const sellH = (d.sell / maxTotal) * 100;
          return (
            <div
              key={d.day}
              className="flex-1 min-w-[3px] flex flex-col justify-end gap-px group relative h-full"
              title={`${d.day}: покупки ${fmtUsd(d.buy)}, продажи ${fmtUsd(d.sell)}`}
            >
              <div className="absolute inset-0 group-hover:bg-slate-700/20 rounded" />
              <div style={{ height: `${buyH}%` }} className="bg-emerald-400/80 rounded-t-[2px] min-h-0" />
              <div style={{ height: `${sellH}%` }} className="bg-red-400/70 rounded-b-[2px] min-h-0" />
            </div>
          );
        })}
      </div>
      <div className="flex justify-between text-[11px] text-slate-600 mt-1">
        <span>{days[0].day}</span>
        <span>{days[days.length - 1].day}</span>
      </div>
      <div className="flex gap-4 mt-2 text-[11px]">
        <span className="flex items-center gap-1.5 text-slate-400"><span className="w-2.5 h-2.5 rounded-sm bg-emerald-400/80" />Покупки</span>
        <span className="flex items-center gap-1.5 text-slate-400"><span className="w-2.5 h-2.5 rounded-sm bg-red-400/70" />Продажи</span>
      </div>
    </div>
  );
}

// ---------- per-token PnL (horizontal, zero-centered) ----------

export function TokenPnlBars({ rows }: { rows: { label: string; value: number }[] }) {
  if (rows.length === 0) return null;
  const maxAbs = Math.max(...rows.map((r) => Math.abs(r.value)), 1);

  return (
    <div className="space-y-1.5">
      {rows.map((r) => {
        const pct = (Math.abs(r.value) / maxAbs) * 50; // half-width from center
        const pos = r.value >= 0;
        return (
          <div key={r.label} className="grid grid-cols-[90px_1fr_80px] items-center gap-2 text-sm">
            <span className="text-slate-300 truncate text-xs font-medium">{r.label}</span>
            <div className="relative h-5 bg-slate-800/40 rounded">
              <div className="absolute inset-y-0 left-1/2 w-px bg-slate-700" />
              <div
                className={`absolute inset-y-0.5 rounded-sm ${pos ? "bg-emerald-400/80" : "bg-red-400/70"}`}
                style={pos ? { left: "50%", width: `${pct}%` } : { right: "50%", width: `${pct}%` }}
              />
            </div>
            <span className={`text-right text-xs font-bold ${pos ? "text-emerald-400" : "text-red-400"}`}>{fmtUsd(r.value)}</span>
          </div>
        );
      })}
    </div>
  );
}
