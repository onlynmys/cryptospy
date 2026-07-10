export interface WalletStats {
  address: string;
  shortAddress: string;
  winRate: number;
  totalTrades: number;
  wins: number;
  losses: number;
  totalPnlUsd: number;
  avgBuyUsd: number;
  avgSellUsd: number;
  lastActivity: number;
  recentTrades: TradeRecord[];
  tags: string[];
  score: number;
}

export interface TradeRecord {
  tokenSymbol: string;
  tokenAddress: string;
  type: "buy" | "sell";
  amountUsd: number;
  priceUsd: number;
  timestamp: number;
  txHash: string;
  pnlUsd?: number;
}

function shortAddr(addr: string) {
  return addr.slice(0, 6) + "..." + addr.slice(-4);
}

function scoreTags(w: WalletStats): string[] {
  const tags: string[] = [];
  if (w.winRate >= 0.75) tags.push("🎯 Smart Money");
  if (w.winRate >= 0.85) tags.push("🔥 Top Trader");
  if (w.totalPnlUsd > 100000) tags.push("💎 Whale");
  if (w.totalTrades > 200) tags.push("⚡ Active");
  if (w.avgBuyUsd < 500 && w.totalPnlUsd > 10000) tags.push("🚀 Sniper");
  if (tags.length === 0) tags.push("👤 Regular");
  return tags;
}

function calcScore(w: Omit<WalletStats, "tags" | "score">): number {
  const winScore = w.winRate * 40;
  const pnlScore = Math.min(Math.log10(Math.max(w.totalPnlUsd, 1)) * 5, 30);
  const activityScore = Math.min(w.totalTrades / 10, 20);
  const recencyScore = Date.now() / 1000 - w.lastActivity < 86400 ? 10 : 0;
  return Math.round(winScore + pnlScore + activityScore + recencyScore);
}

export async function analyzeWalletsFromTrades(
  rawTrades: { maker: string; type: "buy" | "sell"; amountUsd: string; priceUsd: string; blockTimestamp: string; txHash: string }[],
  tokenSymbol: string,
  tokenAddress: string
): Promise<WalletStats[]> {
  const walletMap = new Map<string, TradeRecord[]>();

  for (const t of rawTrades) {
    if (!t.maker) continue;
    const rec: TradeRecord = {
      tokenSymbol,
      tokenAddress,
      type: t.type,
      amountUsd: parseFloat(t.amountUsd) || 0,
      priceUsd: parseFloat(t.priceUsd) || 0,
      timestamp: new Date(t.blockTimestamp).getTime() / 1000,
      txHash: t.txHash,
    };
    const list = walletMap.get(t.maker) || [];
    list.push(rec);
    walletMap.set(t.maker, list);
  }

  const results: WalletStats[] = [];

  for (const [address, trades] of walletMap.entries()) {
    const buys = trades.filter((t) => t.type === "buy");
    const sells = trades.filter((t) => t.type === "sell");

    if (buys.length === 0) continue;

    const totalBuyUsd = buys.reduce((s, t) => s + t.amountUsd, 0);
    const totalSellUsd = sells.reduce((s, t) => s + t.amountUsd, 0);
    const pnlUsd = totalSellUsd - totalBuyUsd;

    const wins = pnlUsd > 0 ? 1 : 0;
    const losses = pnlUsd <= 0 ? 1 : 0;
    const winRate = wins / (wins + losses);

    const partial: Omit<WalletStats, "tags" | "score"> = {
      address,
      shortAddress: shortAddr(address),
      winRate,
      totalTrades: trades.length,
      wins,
      losses,
      totalPnlUsd: pnlUsd,
      avgBuyUsd: totalBuyUsd / Math.max(buys.length, 1),
      avgSellUsd: totalSellUsd / Math.max(sells.length, 1),
      lastActivity: Math.max(...trades.map((t) => t.timestamp)),
      recentTrades: trades.sort((a, b) => b.timestamp - a.timestamp).slice(0, 10),
    };

    const score = calcScore(partial);
    const full: WalletStats = { ...partial, score, tags: [] };
    full.tags = scoreTags(full);

    results.push(full);
  }

  return results.sort((a, b) => b.score - a.score);
}

export function fmt(n: number, decimals = 2): string {
  if (Math.abs(n) >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (Math.abs(n) >= 1_000) return (n / 1_000).toFixed(1) + "K";
  return n.toFixed(decimals);
}

export function fmtPct(n: number): string {
  const sign = n > 0 ? "+" : "";
  return sign + n.toFixed(2) + "%";
}

export function timeAgo(ts: number): string {
  const sec = Math.floor(Date.now() / 1000 - ts);
  if (sec < 60) return sec + "s ago";
  if (sec < 3600) return Math.floor(sec / 60) + "m ago";
  if (sec < 86400) return Math.floor(sec / 3600) + "h ago";
  return Math.floor(sec / 86400) + "d ago";
}
