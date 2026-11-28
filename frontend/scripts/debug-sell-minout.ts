/**
 * Probe sell with minAmountOut=1 to see if SlippageExceeded is quote-side or pool-side.
 */
import fs from "node:fs";
import {
  Connection,
  Keypair,
  Transaction,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { PublicKey } from "@solana/web3.js";
import { fetchOmnipairPoolSnapshot } from "../src/lib/omnipairPoolState";
import { sendOmnipairSwapTx } from "../src/lib/omnipairSwap";

async function main() {
  const traders = JSON.parse(
    fs.readFileSync(".e2e-tmp/multi-traders.json", "utf8")
  ) as { secret: number[] }[];
  const connection = new Connection(
    process.env.NEXT_PUBLIC_SOLANA_RPC_URL!,
    "confirmed"
  );
  const mint = new PublicKey("Jr9S1noL7o1pDSXMvGVZ44tC73D747Veb21ixxPNBnp");
  const pool = "BQimVDPMiU3zcadJDwQ2WpZFGKC9Xpeu36YJAP31P6gK";

  // Find a trader with token inventory
  let kp: Keypair | null = null;
  let tok = 0;
  for (const t of traders) {
    const cand = Keypair.fromSecretKey(Uint8Array.from(t.secret));
    try {
      const ata = getAssociatedTokenAddressSync(mint, cand.publicKey, true);
      const bal = await connection.getTokenAccountBalance(ata);
      const ui = Number(bal.value.uiAmountString || "0");
      if (ui > 500) {
        kp = cand;
        tok = ui;
        break;
      }
    } catch {
      /* continue */
    }
  }
  if (!kp) throw new Error("no trader with tokens");
  console.log(
    "trader",
    kp.publicKey.toBase58().slice(0, 8),
    "tok",
    tok,
    "sol",
    (await connection.getBalance(kp.publicKey)) / LAMPORTS_PER_SOL
  );

  const snap = await fetchOmnipairPoolSnapshot(
    connection,
    pool,
    mint.toBase58(),
    kp.publicKey
  );
  if (!snap.ok) throw new Error(snap.message);
  console.log("reserves", {
    sol: Number(snap.data.reserveSolRaw) / 1e9,
    tok: Number(snap.data.reserveProjectRaw) / 1e6,
    spot: snap.data.spotPriceSol,
  });

  const wallet = {
    publicKey: kp.publicKey,
    signTransaction: async (tx: Transaction) => {
      tx.partialSign(kp!);
      return tx;
    },
    signAllTransactions: async (txs: Transaction[]) => {
      for (const t of txs) t.partialSign(kp!);
      return txs;
    },
  };

  // Force near-zero min out via 99.99% slippage
  try {
    const res = await sendOmnipairSwapTx({
      connection,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      wallet: wallet as any,
      snapshot: snap.data,
      side: "sell",
      amountUi: Math.min(200, tok * 0.02),
      slippagePercent: 99.5,
    });
    console.log("SELL OK", res.signature);
  } catch (e: unknown) {
    const err = e as { message?: string; logs?: string[] };
    console.error("SELL FAIL", err.message || e);
    if (err.logs) console.error(err.logs.slice(-15).join("\n"));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
