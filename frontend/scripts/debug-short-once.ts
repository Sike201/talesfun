import fs from "node:fs";
import { Connection, Keypair, Transaction, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { fetchOmnipairPoolSnapshot } from "../src/lib/omnipairPoolState";
import { sendOmnipairLeverageStepTx } from "../src/lib/omnipairLending";

async function main() {
  const traders = JSON.parse(
    fs.readFileSync(".e2e-tmp/multi-traders.json", "utf8")
  ) as { secret: number[]; pubkey: string }[];
  const rec = traders[0]!;
  const kp = Keypair.fromSecretKey(Uint8Array.from(rec.secret));
  const connection = new Connection(
    process.env.NEXT_PUBLIC_SOLANA_RPC_URL!,
    "confirmed"
  );
  console.log(
    "trader",
    kp.publicKey.toBase58(),
    "sol",
    (await connection.getBalance(kp.publicKey)) / LAMPORTS_PER_SOL
  );
  const mint = "Jr9S1noL7o1pDSXMvGVZ44tC73D747Veb21ixxPNBnp";
  const pool = "BQimVDPMiU3zcadJDwQ2WpZFGKC9Xpeu36YJAP31P6gK";
  const snap = await fetchOmnipairPoolSnapshot(
    connection,
    pool,
    mint,
    kp.publicKey
  );
  if (!snap.ok) throw new Error(snap.message);
  console.log("spot", snap.data.spotPriceSol, {
    rSol: Number(snap.data.reserveSolRaw) / 1e9,
    rTok: Number(snap.data.reserveProjectRaw) / 1e6,
  });
  const wallet = {
    publicKey: kp.publicKey,
    signTransaction: async (tx: Transaction) => {
      tx.partialSign(kp);
      return tx;
    },
    signAllTransactions: async (txs: Transaction[]) => {
      for (const t of txs) t.partialSign(kp);
      return txs;
    },
  };
  try {
    const res = await sendOmnipairLeverageStepTx({
      connection,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      wallet: wallet as any,
      snapshot: snap.data,
      direction: "short",
      marginUi: 0.01,
      leverage: 1.2,
      slippagePercent: 25,
    });
    console.log("SHORT OK", res);
  } catch (e: unknown) {
    const err = e as {
      message?: string;
      logs?: string[];
      getLogs?: () => string[];
    };
    console.error("SHORT FAIL", err?.message || e);
    const logs = err?.logs || (typeof err?.getLogs === "function" ? err.getLogs() : undefined);
    if (logs) console.error(logs.join("\n"));
  }
}

main();
