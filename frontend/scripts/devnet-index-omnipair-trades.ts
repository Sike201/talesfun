/**
 * Pull Omnipair swap txs from RPC for graduated pairs and upsert into trades
 * (powers candles / 24h volume). Usage:
 *   npx tsx --env-file=.env.local scripts/devnet-index-omnipair-trades.ts
 */
import { Connection } from "@solana/web3.js";
import { runOmnipairSwapIndexer } from "../src/lib/omnipairIndexer";

async function main() {
  const connection = new Connection(
    process.env.NEXT_PUBLIC_SOLANA_RPC_URL || "https://api.devnet.solana.com",
    "confirmed"
  );
  const result = await runOmnipairSwapIndexer(connection, { limitPerPair: 80 });
  console.log("INDEX RESULT", result);
  if (result.errors.length) {
    console.warn("INDEX ERRORS", result.errors.slice(0, 10));
  }
  process.exit(0);
}

main().catch((e) => {
  console.error("INDEX FAIL", e);
  process.exit(1);
});
