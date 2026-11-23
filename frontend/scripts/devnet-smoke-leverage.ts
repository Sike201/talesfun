/**
 * Smoke: one recursive leverage step (short or long) on an Omnipair V1 pair.
 * Usage: npx tsx --env-file=.env.local scripts/devnet-smoke-leverage.ts <mint> [long|short]
 */
import fs from "node:fs";
import path from "node:path";
import { Connection, Keypair, PublicKey, Transaction } from "@solana/web3.js";
import {
  getReadOnlyProgram,
  getTokenStatePDA,
  tokenStateToToken,
} from "../src/lib/program";
import { fetchOmnipairPoolSnapshot } from "../src/lib/omnipairPoolState";
import { sendOmnipairLeverageStepTx } from "../src/lib/omnipairLending";

async function main() {
  const mintStr = process.argv[2];
  const direction = (process.argv[3] === "long" ? "long" : "short") as
    | "long"
    | "short";
  if (!mintStr) throw new Error("Usage: … <mint> [long|short]");
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

  const snap = await fetchOmnipairPoolSnapshot(
    connection,
    token.gammPool,
    mintStr,
    kp.publicKey
  );
  if (!snap.ok) throw new Error(snap.message);
  console.log("spot", snap.data.spotPriceSol, "direction", direction);

  const marginUi = direction === "short" ? 0.02 : 1000;
  const res = await sendOmnipairLeverageStepTx({
    connection,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    wallet: wallet as any,
    snapshot: snap.data,
    direction,
    marginUi,
    leverage: 2,
    slippagePercent: 8,
  });
  console.log("LEVERAGE OK", res);
  process.exit(0);
}

main().catch((e) => {
  console.error("LEVERAGE FAIL", e);
  process.exit(1);
});
