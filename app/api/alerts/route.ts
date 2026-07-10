import { NextRequest, NextResponse } from "next/server";

const BASE = "https://api.dexscreener.com";

export interface RealAlert {
  id: string;
  type: "pump" | "dump" | "new_pair" | "volume_spike" | "buy_pressure" | "sell_pressure";
  tokenSymbol: string;
  tokenName: string;
  chainId: string;
  pairAddress: string;
  tokenAddress: string;
  priceUsd: string;
  priceChangeM5: number;
  priceChangeH1: number;
  priceChange24h: number;
  volumeM5: number;
  volumeH1: number;
  volumeH24: number;
  liquidityUsd: number;
  fdv: number;
  buys24h: number;
  sells24h: number;
  buysH1: number;
  sellsH1: number;
  buyPressure: number;
  pairAgeMinutes: number;
  dexId: string;
  url: string;
  timestamp: number;
  title: string;
  description: string;
}

interface DexPair {
  chainId: string;
  dexId: string;
  pairAddress: string;
  url: string;
  baseToken: { address: string; symbol: string; name: string };
  priceUsd?: string;
  priceChange?: { m5?: number; h1?: number; h6?: number; h24?: number };
  volume?: { m5?: number; h1?: number; h6?: number; h24?: number };
  liquidity?: { usd?: number };
  fdv?: number;
  txns?: {
    m5?: { buys?: number; sells?: number };
    h1?: { buys?: number; sells?: number };
    h24?: { buys?: number; sells?: number };
  };
  pairCreatedAt?: number;
}

function buildAlert(pair: DexPair, type: RealAlert["type"]): RealAlert {
  const h1txns = pair.txns?.h1 || {};
  const h24txns = pair.txns?.h24 || {};
  const buysH1 = h1txns.buys || 0;
  const sellsH1 = h1txns.sells || 0;
  const totalH1 = buysH1 + sellsH1;
  const buyPressure = totalH1 > 0 ? Math.round((buysH1 / totalH1) * 100) : 50;

  const pairAgeMs = pair.pairCreatedAt ? Date.now() - pair.pairCreatedAt : Infinity;
  const pairAgeMinutes = Math.floor(pairAgeMs / 60000);

  const changeM5 = pair.priceChange?.m5 ?? 0;
  const changeH1 = pair.priceChange?.h1 ?? 0;
  const change24h = pair.priceChange?.h24 ?? 0;
  const volM5 = pair.volume?.m5 ?? 0;
  const volH1 = pair.volume?.h1 ?? 0;
  const volH24 = pair.volume?.h24 ?? 0;
  const liq = pair.liquidity?.usd ?? 0;

  const titles: Record<RealAlert["type"], string> = {
    pump: `🚀 Памп +${changeM5.toFixed(1)}% за 5 мин`,
    dump: `📉 Дамп ${changeM5.toFixed(1)}% за 5 мин`,
    new_pair: `🆕 Новая пара — ${pairAgeMinutes < 60 ? pairAgeMinutes + " мин" : Math.floor(pairAgeMinutes / 60) + "ч"}`,
    volume_spike: `⚡ Взрыв объёма — $${fmtNum(volM5)} за 5 мин`,
    buy_pressure: `🟢 Давление покупок ${buyPressure}% Buy`,
    sell_pressure: `🔴 Давление продаж ${100 - buyPressure}% Sell`,
  };

  const descriptions: Record<RealAlert["type"], string> = {
    pump: `Цена выросла на ${changeM5.toFixed(2)}% за последние 5 минут. Объём за 5 мин: $${fmtNum(volM5)}. Ликвидность: $${fmtNum(liq)}`,
    dump: `Цена упала на ${Math.abs(changeM5).toFixed(2)}% за последние 5 минут. Объём за 5 мин: $${fmtNum(volM5)}. Ликвидность: $${fmtNum(liq)}`,
    new_pair: `Пара создана ${pairAgeMinutes < 60 ? pairAgeMinutes + " минут" : Math.floor(pairAgeMinutes / 60) + " часов"} назад. Уже объём $${fmtNum(volH24)} за 24ч. Ликвидность: $${fmtNum(liq)}`,
    volume_spike: `Объём за 5 мин ($${fmtNum(volM5)}) составляет ${volH1 > 0 ? Math.round((volM5 / volH1) * 100) : "?"}% от часового. Резкое ускорение торговли.`,
    buy_pressure: `${buysH1} покупок против ${sellsH1} продаж за последний час. Сильное давление покупателей.`,
    sell_pressure: `${sellsH1} продаж против ${buysH1} покупок за последний час. Сильное давление продавцов.`,
  };

  return {
    id: `${type}-${pair.pairAddress}-${Date.now()}`,
    type,
    tokenSymbol: pair.baseToken.symbol,
    tokenName: pair.baseToken.name,
    chainId: pair.chainId,
    pairAddress: pair.pairAddress,
    tokenAddress: pair.baseToken.address,
    priceUsd: pair.priceUsd || "0",
    priceChangeM5: changeM5,
    priceChangeH1: changeH1,
    priceChange24h: change24h,
    volumeM5: volM5,
    volumeH1: volH1,
    volumeH24: volH24,
    liquidityUsd: liq,
    fdv: pair.fdv || 0,
    buys24h: h24txns.buys || 0,
    sells24h: h24txns.sells || 0,
    buysH1,
    sellsH1,
    buyPressure,
    pairAgeMinutes,
    dexId: pair.dexId,
    url: pair.url || `https://dexscreener.com/${pair.chainId}/${pair.pairAddress}`,
    timestamp: Date.now() / 1000,
    title: titles[type],
    description: descriptions[type],
  };
}

function fmtNum(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "K";
  return n.toFixed(0);
}

async function fetchPairs(chain: string): Promise<DexPair[]> {
  try {
    const r = await fetch(`${BASE}/token-profiles/latest/v1`, { next: { revalidate: 30 } });
    if (!r.ok) return [];
    const profiles = await r.json() as { tokenAddress: string; chainId: string }[];
    const filtered = profiles.filter((p) => !chain || p.chainId === chain).slice(0, 40);
    if (filtered.length === 0) return [];

    const addrs = filtered.map((p) => p.tokenAddress).join(",");
    const r2 = await fetch(`${BASE}/latest/dex/tokens/${addrs}`, { next: { revalidate: 30 } });
    if (!r2.ok) return [];
    const d = await r2.json();
    return (d.pairs || []) as DexPair[];
  } catch {
    return [];
  }
}

export async function GET(req: NextRequest) {
  const chain = req.nextUrl.searchParams.get("chain") || "";

  const pairs = await fetchPairs(chain);
  const alerts: RealAlert[] = [];

  for (const pair of pairs) {
    const changeM5 = pair.priceChange?.m5 ?? 0;
    const volM5 = pair.volume?.m5 ?? 0;
    const volH1 = pair.volume?.h1 ?? 1;
    const liq = pair.liquidity?.usd ?? 0;
    const h1txns = pair.txns?.h1 || {};
    const buysH1 = h1txns.buys || 0;
    const sellsH1 = h1txns.sells || 0;
    const totalH1 = buysH1 + sellsH1;
    const buyPct = totalH1 > 0 ? (buysH1 / totalH1) * 100 : 50;
    const pairAgeMs = pair.pairCreatedAt ? Date.now() - pair.pairCreatedAt : Infinity;
    const pairAgeMinutes = pairAgeMs / 60000;
    const volM5Pct = volH1 > 0 ? (volM5 / volH1) * 100 : 0;

    if (changeM5 >= 10 && liq >= 5000) {
      alerts.push(buildAlert(pair, "pump"));
    } else if (changeM5 <= -10 && liq >= 5000) {
      alerts.push(buildAlert(pair, "dump"));
    } else if (pairAgeMinutes < 120 && volM5 > 1000) {
      alerts.push(buildAlert(pair, "new_pair"));
    } else if (volM5Pct > 30 && volM5 > 5000) {
      alerts.push(buildAlert(pair, "volume_spike"));
    } else if (buyPct >= 70 && totalH1 >= 10) {
      alerts.push(buildAlert(pair, "buy_pressure"));
    } else if (buyPct <= 30 && totalH1 >= 10) {
      alerts.push(buildAlert(pair, "sell_pressure"));
    }
  }

  // Sort by most extreme first
  alerts.sort((a, b) => Math.abs(b.priceChangeM5) - Math.abs(a.priceChangeM5));

  return NextResponse.json({ alerts, count: alerts.length, updatedAt: Date.now() });
}
