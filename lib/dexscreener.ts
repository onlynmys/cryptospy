const BASE = "https://api.dexscreener.com";

export interface DexPair {
  chainId: string;
  dexId: string;
  url: string;
  pairAddress: string;
  baseToken: { address: string; name: string; symbol: string };
  quoteToken: { address: string; name: string; symbol: string };
  priceNative: string;
  priceUsd?: string;
  txns: {
    m5: { buys: number; sells: number };
    h1: { buys: number; sells: number };
    h6: { buys: number; sells: number };
    h24: { buys: number; sells: number };
  };
  volume: { m5: number; h1: number; h6: number; h24: number };
  priceChange: { m5: number; h1: number; h6: number; h24: number };
  liquidity?: { usd: number; base: number; quote: number };
  fdv?: number;
  marketCap?: number;
  pairCreatedAt?: number;
  info?: { imageUrl?: string; websites?: { url: string }[]; socials?: { type: string; url: string }[] };
}

export interface DexTrade {
  blockTimestamp: string;
  type: "buy" | "sell";
  priceUsd: string;
  amountUsd: string;
  maker: string;
  txHash: string;
}

export async function getTrendingTokens(chain?: string): Promise<DexPair[]> {
  const url = chain
    ? `${BASE}/token-profiles/latest/v1`
    : `${BASE}/token-profiles/latest/v1`;

  const profiles = await fetch(url, { next: { revalidate: 60 } }).then((r) =>
    r.ok ? r.json() : []
  );

  const addresses = (profiles as { tokenAddress: string; chainId: string }[])
    .filter((p) => !chain || p.chainId === chain)
    .slice(0, 30)
    .map((p) => p.tokenAddress)
    .join(",");

  if (!addresses) return [];

  const res = await fetch(`${BASE}/latest/dex/tokens/${addresses}`, {
    next: { revalidate: 60 },
  });
  if (!res.ok) return [];
  const data = await res.json();
  return (data.pairs || []) as DexPair[];
}

export async function searchTokens(q: string): Promise<DexPair[]> {
  const res = await fetch(`${BASE}/latest/dex/search?q=${encodeURIComponent(q)}`, {
    next: { revalidate: 30 },
  });
  if (!res.ok) return [];
  const data = await res.json();
  return (data.pairs || []) as DexPair[];
}

export async function getTokenPairs(address: string): Promise<DexPair[]> {
  const res = await fetch(`${BASE}/latest/dex/tokens/${address}`, {
    next: { revalidate: 30 },
  });
  if (!res.ok) return [];
  const data = await res.json();
  return (data.pairs || []) as DexPair[];
}

export async function getPairTrades(chainId: string, pairAddress: string): Promise<DexTrade[]> {
  const res = await fetch(`${BASE}/latest/dex/pairs/${chainId}/${pairAddress}`, {
    next: { revalidate: 15 },
  });
  if (!res.ok) return [];
  const data = await res.json();
  return (data.pair?.txns?.recent || []) as DexTrade[];
}

export async function getBoostTokens(): Promise<DexPair[]> {
  const res = await fetch(`${BASE}/token-boosts/top/v1`, { next: { revalidate: 120 } });
  if (!res.ok) return [];
  const boosted = await res.json() as { tokenAddress: string; chainId: string }[];
  const addresses = boosted.slice(0, 20).map((b) => b.tokenAddress).join(",");
  if (!addresses) return [];
  const r2 = await fetch(`${BASE}/latest/dex/tokens/${addresses}`, { next: { revalidate: 60 } });
  if (!r2.ok) return [];
  const d = await r2.json();
  return (d.pairs || []) as DexPair[];
}
