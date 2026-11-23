/**
 * Quick AFK verify: on-chain pool spot/mcap + local trade journal → candles.
 *   npx tsx --env-file=.env.local scripts/devnet-verify-pools.ts [mint…]
 */
import { Connection, PublicKey } from "@solana/web3.js";
import { listLocalTrades } from "../src/lib/localTradeStore";
import { aggregateTradesToCandles } from "../src/lib/candles";
import {
  getReadOnlyProgram,
  getTokenStatePDA,
  tokenStateToToken,
} from "../src/lib/program";
import { fetchOmnipairPoolSnapshot } from "../src/lib/omnipairPoolState";

async function main() {
  const connection = new Connection(
    process.env.NEXT_PUBLIC_SOLANA_RPC_URL || "https://api.devnet.solana.com",
    "confirmed"
  );
  const program = getReadOnlyProgram(connection);
  const mints =
    process.argv.slice(2).length > 0
      ? process.argv.slice(2)
      : [
          "6Em1NQAUWHW4nWhnP9ZGwLyX3FxaXjPy9XLgtLYnjqU4",
          "BK6kSD5Yy1AwR9XZr54gFM5jv3431FvYUTJkV5jtqS9G",
          "6L5dRJQxEGdegycoSYbETqa3MKD92r5NUDc6gntXJmoM",
          "HdiiFYb5YNSPPSKxqdmjBbUiVuALh4oDRvVYKSR8pnkt",
          "FoDCc5WepqFcTvnYVqJaTDMJykSdooFtHha4DQgvnE9H",
          "BeMuMrezx5c76LT9Y1LKWYfAj3XEAda32zaDY3fNiWaz",
        ];

  for (const mintStr of mints) {
    const mint = new PublicKey(mintStr);
    const [pda] = getTokenStatePDA(mint);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const state = await (program.account as any).tokenState
      .fetch(pda)
      .catch(() => null);
    if (!state) {
      console.log({ mint: mintStr, err: "no tokenState" });
      continue;
    }
    const token = tokenStateToToken(state, mintStr);
    const rows = listLocalTrades(mintStr);
    const candles = aggregateTradesToCandles(
      rows.map((r) => ({
        price_sol: r.price_sol,
        timestamp: r.timestamp,
        sol_amount_raw: r.sol_amount_raw,
      })),
      "1m"
    );
    const vol = rows.reduce(
      (s, r) => s + Number(BigInt(r.sol_amount_raw || "0")) / 1e9,
      0
    );
    let spot: number | null = null;
    let mcapSol: number | null = null;
    let reserveSol: number | null = null;
    if (token.gammPool) {
      const snap = await fetchOmnipairPoolSnapshot(
        connection,
        token.gammPool,
        mintStr,
        null
      );
      if (snap.ok) {
        spot = snap.data.spotPriceSol;
        reserveSol =
          Number(snap.data.reserveSolRaw) / 10 ** snap.data.solDecimals;
        mcapSol = spot * 1e9;
      }
    }
    console.log({
      mint: mintStr,
      phase: token.phase,
      gammPool: token.gammPool,
      trades: rows.length,
      candles: candles.length,
      volSol: Number(vol.toFixed(6)),
      spot,
      reserveSol,
      mcapSol,
    });
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
