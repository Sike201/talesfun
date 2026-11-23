/**
 * Market-make small Omnipair buys/sells so charts fill with candles.
 * Usage:
 *   npx tsx --env-file=.env.local scripts/devnet-market-make.ts <mint> [rounds=8]
 */
import fs from "node:fs";
import path from "node:path";
import { Connection, Keypair, PublicKey, Transaction } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import {
  getReadOnlyProgram,
  getTokenStatePDA,
  tokenStateToToken,
} from "../src/lib/program";
import { fetchOmnipairPoolSnapshot } from "../src/lib/omnipairPoolState";
import { sendOmnipairSwapTx } from "../src/lib/omnipairSwap";
import { upsertLocalTrade } from "../src/lib/localTradeStore";

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function log(...args: unknown[]) {
  console.log(...args);
  if (typeof (console as { flush?: () => void }).flush === "function") {
    (console as { flush?: () => void }).flush?.();
  }
}

async function main() {
  const mintStr = process.argv[2];
  const rounds = Math.max(1, Number(process.argv[3] || "8"));
  if (!mintStr) throw new Error("Usage: … <mint> [rounds=8]");

  const mint = new PublicKey(mintStr);
  const secret = JSON.parse(
    fs.readFileSync(path.join(process.env.HOME!, ".config/solana/id.json"), "utf8")
  ) as number[];
  const kp = Keypair.fromSecretKey(Uint8Array.from(secret));
  const connection = new Connection(
    process.env.NEXT_PUBLIC_SOLANA_RPC_URL || "https://api.devnet.solana.com",
    "confirmed"
  );
  const wallet = {
    publicKey: kp.publicKey,
    signTransaction: async <T extends Transaction>(tx: T) => {
      tx.partialSign(kp);
      return tx;
    },
    signAllTransactions: async <T extends Transaction>(txs: T[]) => {
      for (const t of txs) t.partialSign(kp);
      return txs;
    },
  };

  const program = getReadOnlyProgram(connection);
  const [pda] = getTokenStatePDA(mint);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const state = await (program.account as any).tokenState.fetch(pda);
  const token = tokenStateToToken(state, mintStr);
  if (!token.gammPool) throw new Error("no gamm pool");

  log("MM start", {
    mint: mintStr,
    pool: token.gammPool,
    rounds,
    payer: kp.publicKey.toBase58(),
  });

  for (let i = 1; i <= rounds; i++) {
    try {
      const snap = await fetchOmnipairPoolSnapshot(
        connection,
        token.gammPool,
        mintStr,
        kp.publicKey
      );
      if (!snap.ok) {
        log(`#${i} snapshot fail`, snap.message);
        await sleep(2000);
        continue;
      }

      const buySol = 0.008 + Math.random() * 0.012;
      const buy = await sendOmnipairSwapTx({
        connection,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        wallet: wallet as any,
        snapshot: snap.data,
        side: "buy",
        amountUi: buySol,
        slippagePercent: 10,
      });
      upsertLocalTrade({
        mint: mintStr,
        signature: buy.signature,
        side: "buy",
        sol_amount_raw: buy.fill.sol_amount_raw,
        token_amount_raw: buy.fill.token_amount_raw,
        timestamp: buy.fill.timestamp,
        wallet: kp.publicKey.toBase58(),
        price_sol: buy.fill.price_sol,
        source: "omnipair",
      });
      log(`#${i} BUY`, buySol.toFixed(4), "SOL", buy.signature.slice(0, 12));

      await sleep(1500);

      const ata = getAssociatedTokenAddressSync(mint, kp.publicKey);
      const bal = await connection
        .getTokenAccountBalance(ata, "confirmed")
        .catch(() => null);
      const ui = Number(bal?.value.uiAmountString ?? "0");
      if (!(ui > 50)) {
        log(`#${i} skip sell (bal ${ui})`);
        await sleep(1500);
        continue;
      }

      const sellUi = Math.min(ui * (0.3 + Math.random() * 0.25), ui * 0.55);
      const snap2 = await fetchOmnipairPoolSnapshot(
        connection,
        token.gammPool,
        mintStr,
        kp.publicKey
      );
      if (!snap2.ok) {
        log(`#${i} sell snapshot fail`, snap2.message);
        continue;
      }
      const sell = await sendOmnipairSwapTx({
        connection,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        wallet: wallet as any,
        snapshot: snap2.data,
        side: "sell",
        amountUi: sellUi,
        slippagePercent: 10,
      });
      upsertLocalTrade({
        mint: mintStr,
        signature: sell.signature,
        side: "sell",
        sol_amount_raw: sell.fill.sol_amount_raw,
        token_amount_raw: sell.fill.token_amount_raw,
        timestamp: sell.fill.timestamp,
        wallet: kp.publicKey.toBase58(),
        price_sol: sell.fill.price_sol,
        source: "omnipair",
      });
      log(`#${i} SELL`, sellUi.toFixed(2), "tok", sell.signature.slice(0, 12));
    } catch (e) {
      log(`#${i} FAIL`, e instanceof Error ? e.message : e);
    }
    await sleep(2000);
  }

  log("MM done", { rounds });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
