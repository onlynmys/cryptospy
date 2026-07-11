// Free replacement for the Helius webhook: subscribes directly to Solana's
// public RPC pubsub (no API key, no credits, $0) for program logs on our
// watched DEX programs, then fetches the full transaction for each matching
// signature via the same public RPC's standard getTransaction method.
//
// Tradeoffs vs. the paid webhook: the public endpoint is shared by everyone
// and rate-limited, so under heavy load (Jupiter especially) we will drop
// some transactions rather than process 100% of them — that's an accepted
// degradation in exchange for genuinely zero cost. Partial real coverage
// beats no coverage.

import WebSocket from "ws";
import type { RawHeliusTx } from "../lib/scannerCore";

const WS_URL = "wss://api.mainnet-beta.solana.com";
const HTTP_URL = "https://api.mainnet-beta.solana.com";

// Conservative self-throttling — the public endpoint's real limits are
// undocumented/variable, so we stay well under what's generally tolerated.
const MAX_REQ_PER_SEC = 6;
const MAX_QUEUE = 300;

export interface FeedStats {
  connected: boolean;
  queued: number;
  fetched: number;
  dropped: number;
  errors: number;
  reconnects: number;
}

export function startSolanaFeed(
  programAddresses: string[],
  onSwap: (tx: RawHeliusTx) => void
): FeedStats {
  const stats: FeedStats = { connected: false, queued: 0, fetched: 0, dropped: 0, errors: 0, reconnects: 0 };
  const queue: string[] = [];
  let inFlight = 0;
  const subIdToAddress = new Map<number, string>();

  async function fetchTransaction(signature: string) {
    inFlight++;
    try {
      const res = await fetch(HTTP_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "getTransaction",
          params: [signature, { encoding: "json", maxSupportedTransactionVersion: 0, commitment: "confirmed" }],
        }),
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) { stats.errors++; return; }
      const data = await res.json();
      const tx = data?.result as RawHeliusTx | null;
      if (tx) {
        stats.fetched++;
        onSwap(tx);
      }
    } catch {
      stats.errors++;
    } finally {
      inFlight--;
    }
  }

  // Drains the signature queue at a fixed, conservative rate.
  setInterval(() => {
    const budget = Math.max(0, MAX_REQ_PER_SEC - inFlight);
    for (let i = 0; i < budget && queue.length > 0; i++) {
      const sig = queue.shift();
      if (sig) fetchTransaction(sig);
    }
    stats.queued = queue.length;
  }, 1000 / MAX_REQ_PER_SEC);

  function connect() {
    const ws = new WebSocket(WS_URL);

    ws.on("open", () => {
      stats.connected = true;
      console.log(`solanaFeed: connected, subscribing to ${programAddresses.length} programs`);
      programAddresses.forEach((addr, i) => {
        ws.send(JSON.stringify({
          jsonrpc: "2.0",
          id: i + 1,
          method: "logsSubscribe",
          params: [{ mentions: [addr] }, { commitment: "confirmed" }],
        }));
      });
    });

    ws.on("message", (raw) => {
      try {
        const msg = JSON.parse(raw.toString());

        // Subscription confirmation: {"id":N,"result":subId}
        if (typeof msg.id === "number" && typeof msg.result === "number") {
          subIdToAddress.set(msg.result, programAddresses[msg.id - 1]);
          return;
        }

        // Log notification
        if (msg.method === "logsNotification") {
          const value = msg.params?.result?.value;
          if (!value || value.err) return; // skip failed transactions up front
          const signature = value.signature;
          if (!signature) return;

          if (queue.length >= MAX_QUEUE) {
            stats.dropped++;
            return; // queue full — drop rather than grow unbounded under load
          }
          queue.push(signature);
        }
      } catch {
        stats.errors++;
      }
    });

    ws.on("close", () => {
      stats.connected = false;
      stats.reconnects++;
      setTimeout(connect, 3000);
    });

    ws.on("error", () => {
      stats.connected = false;
      ws.close();
    });
  }

  connect();
  return stats;
}
