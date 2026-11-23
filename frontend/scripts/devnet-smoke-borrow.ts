/**
 * Smoke: add project collateral + borrow SOL on an Omnipair V1 pair.
 * Usage: npx tsx --env-file=.env.local scripts/devnet-smoke-borrow.ts <mint>
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
import { sendOmnipairBorrowAgainstProjectTx } from "../src/lib/omnipairLending";

async function main() {
  const mintStr = process.argv[2];
  if (!mintStr) throw new Error("Usage: … <mint>");
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

  const ata = getAssociatedTokenAddressSync(mint, kp.publicKey);
  const bal = await connection.getTokenAccountBalance(ata, "confirmed");
  const ui = Number(bal.value.uiAmountString || "0");
  console.log("token balance", ui);
  if (!(ui > 0)) throw new Error("need project tokens for collateral");

  const snap = await fetchOmnipairPoolSnapshot(
    connection,
    token.gammPool,
    mintStr,
    kp.publicKey
  );
  if (!snap.ok) throw new Error(snap.message);

  // Use a tiny slice so smoke stays cheap.
  const coll = Math.min(ui * 0.05, ui);
  console.log("posting collateral", coll, "borrow ~22% value in SOL (thin-pool CF)");
  const res = await sendOmnipairBorrowAgainstProjectTx({
    connection,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    wallet: wallet as any,
    snapshot: snap.data,
    collateralTokenUi: coll,
  });
  console.log("BORROW OK", res);
  process.exit(0);
}

main().catch((e) => {
  console.error("BORROW FAIL", e);
  process.exit(1);
});
