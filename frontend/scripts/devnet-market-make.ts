/**
 * Market-make small Omnipair buys/sells for a few minutes so charts fill with candles.
 * Usage:
 *   npx tsx --env-file=.env.local scripts/devnet-market-make.ts <mint> [minutes=3]
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

async function main() {
  const mintStr = process.argv[2];
  const minutes = Math.max(1, Number(process.argv[3] || "3"));
  if (!mintStr) throw new Error("Usage: … <mint> [minutes]");

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
  if (!token.gammPool) throw new Error("no gamm pool — token not graduated/bootstrapped");

  const until = Date.now() + minutes * 60_000;
  let i = 0;
  console.log("MM start", {
    mint: mintStr,
    pool: token.gammPool,
    minutes,
    payer: kp.publicKey.toBase58(),
  });

  while (Date.now() < until) {
    i += 1;
    const snap = await fetchOmnipairPoolSnapshot(
      connection,
      token.gammPool,
      mintStr,
      kp.publicKey
    );
    if (!snap.ok) {
      console.warn("snapshot fail", snap.message);
      await sleep(4000);
      continue;
    }

    const buySol = 0.008 + Math.random() * 0.012; // 0.008–0.02 SOL
    try {
      const buy = await sendOmnipairSwapTx({
        connection,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        wallet: wallet as any,
        snapshot: snap.data,
        side: "buy",
        amountUi: buySol,
        slippagePercent: 8,
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
      console.log(`#${i} BUY`, buySol.toFixed(4), "SOL", buy.signature.slice(0, 12));
    } catch (e) {
      console.warn(`#${i} BUY fail`, e instanceof Error ? e.message : e);
    }

    await sleep(2500 + Math.floor(Math.random() * 2000));

    const ata = getAssociatedTokenAddressSync(mint, kp.publicKey);
    const bal = await connection.getTokenAccountBalance(ata, "confirmed").catch(() => null);
    const ui = Number(bal?.value.uiAmountString ?? "0");
    if (ui > 100) {
      const sellUi = Math.min(ui * (0.35 + Math.random() * 0.25), ui * 0.6);
      try {
        const snap2 = await fetchOmnipairPoolSnapshot(
          connection,
          token.gammPool,
          mintStr,
          kp.publicKey
        );
        if (!snap2.ok) throw new Error(snap2.message);
        const sell = await sendOmnipairSwapTx({
          connection,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          wallet: wallet as any,
          snapshot: snap2.data,
          side: "sell",
          amountUi: sellUi,
          slippagePercent: 8,
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
        console.log(`#${i} SELL`, sellUi.toFixed(2), "tok", sell.signature.slice(0, 12));
      } catch (e) {
        console.warn(`#${i} SELL fail`, e instanceof Error ? e.message : e);
      }
    }

    await sleep(3500 + Math.floor(Math.random() * 2500));
  }

  console.log("MM done", { rounds: i });
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
