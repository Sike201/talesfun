import fs from "node:fs";
import path from "node:path";
import {
  Connection,
  Keypair,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import { fetchOmnipairPoolSnapshot } from "../src/lib/omnipairPoolState";
import { sendOmnipairLeverageStepTx } from "../src/lib/omnipairLending";
import { upsertCanonicalTrade } from "../src/lib/persistCanonicalTrade";

async function main() {
  const mint = "Jr9S1noL7o1pDSXMvGVZ44tC73D747Veb21ixxPNBnp";
  const pool = "BQimVDPMiU3zcadJDwQ2WpZFGKC9Xpeu36YJAP31P6gK";
  const connection = new Connection(
    process.env.NEXT_PUBLIC_SOLANA_RPC_URL!,
    "confirmed"
  );
  const payer = Keypair.fromSecretKey(
    Uint8Array.from(
      JSON.parse(
        fs.readFileSync(
          path.join(process.env.HOME!, ".config/solana/phantom.json"),
          "utf8"
        )
      )
    )
  );
  console.log("payer", (await connection.getBalance(payer.publicKey)) / 1e9);

  const fresh = Array.from({ length: 4 }, () => Keypair.generate());
  for (let i = 0; i < fresh.length; i++) {
    const kp = fresh[i]!;
    const tx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: payer.publicKey,
        toPubkey: kp.publicKey,
        lamports: Math.floor(0.25 * LAMPORTS_PER_SOL),
      })
    );
    await sendAndConfirmTransaction(connection, tx, [payer], {
      commitment: "confirmed",
    });
    console.log("funded fresh", i, kp.publicKey.toBase58().slice(0, 8));
  }

  const walletOf = (kp: Keypair) => ({
    publicKey: kp.publicKey,
    signTransaction: async (tx: Transaction) => {
      tx.partialSign(kp);
      return tx;
    },
    signAllTransactions: async (txs: Transaction[]) => {
      for (const t of txs) t.partialSign(kp);
      return txs;
    },
  });

  const levs = [1.2, 2, 3, 5];
  for (let i = 0; i < fresh.length; i++) {
    const kp = fresh[i]!;
    const lev = levs[i]!;
    const snap = await fetchOmnipairPoolSnapshot(
      connection,
      pool,
      mint,
      kp.publicKey
    );
    if (!snap.ok) {
      console.log("snap fail", snap);
      continue;
    }
    try {
      const res = await sendOmnipairLeverageStepTx({
        connection,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        wallet: walletOf(kp) as any,
        snapshot: snap.data,
        direction: "short",
        marginUi: 0.012,
        leverage: lev,
        slippagePercent: 25,
      });
      const sig = res.sigs[res.sigs.length - 1] || res.sigs[0]!;
      await upsertCanonicalTrade({
        mint,
        signature: sig,
        side: "short",
        sol_amount_raw: BigInt(Math.floor(0.012 * 1e9)).toString(),
        token_amount_raw: "0",
        timestamp: new Date().toISOString(),
        wallet: kp.publicKey.toBase58(),
        price_sol: snap.data.spotPriceSol,
        source: "omnipair",
      });
      console.log("SHORT OK", lev + "x", sig.slice(0, 12), "sigs", res.sigs.length);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.log("SHORT FAIL", lev + "x", msg.slice(0, 240));
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
