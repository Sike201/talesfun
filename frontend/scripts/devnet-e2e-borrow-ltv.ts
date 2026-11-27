/**
 * E2E: borrow against project collateral at explicit LTVs (matches new Borrow UI).
 *   npx tsx --env-file=.env.local scripts/devnet-e2e-borrow-ltv.ts
 */
import fs from "node:fs";
import path from "node:path";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { fetchOmnipairPoolSnapshot } from "../src/lib/omnipairPoolState";
import { sendOmnipairSwapTx } from "../src/lib/omnipairSwap";
import { sendOmnipairBorrowAgainstProjectTx } from "../src/lib/omnipairLending";
import { poolSafeCf } from "../src/lib/poolMaxLeverage";
import { upsertCanonicalTrade } from "../src/lib/persistCanonicalTrade";

const ROOT = path.resolve(__dirname, "..");
const meta = JSON.parse(
  fs.readFileSync(path.join(ROOT, ".e2e-tmp/talesfun-test-mint.json"), "utf8")
) as { mint: string; gammPool: string };
const RPC =
  process.env.NEXT_PUBLIC_SOLANA_RPC_URL || "https://api.devnet.solana.com";

function walletOf(kp: Keypair) {
  return {
    publicKey: kp.publicKey,
    signTransaction: async <T extends Transaction>(tx: T) => {
      tx.partialSign(kp);
      return tx;
    },
    signAllTransactions: async <T extends Transaction>(txs: T[]) => {
      txs.forEach(t => t.partialSign(kp));
      return txs;
    },
  };
}

async function main() {
  const phantom = Keypair.fromSecretKey(
    Uint8Array.from(
      JSON.parse(
        fs.readFileSync(
          path.join(process.env.HOME!, ".config/solana/phantom.json"),
          "utf8"
        )
      ) as number[]
    )
  );
  const connection = new Connection(RPC, "confirmed");
  const mint = meta.mint;
  const pool = meta.gammPool;

  const fund = async (kp: Keypair, sol: number) => {
    const tx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: phantom.publicKey,
        toPubkey: kp.publicKey,
        lamports: Math.floor(sol * LAMPORTS_PER_SOL),
      })
    );
    await sendAndConfirmTransaction(connection, tx, [phantom], {
      commitment: "confirmed",
    });
  };

  const tokBal = async (owner: PublicKey) => {
    try {
      const ata = getAssociatedTokenAddressSync(
        new PublicKey(mint),
        owner,
        true
      );
      const bal = await connection.getTokenAccountBalance(ata);
      return Number(bal.value.uiAmountString || "0");
    } catch {
      return 0;
    }
  };

  const snap0 = await fetchOmnipairPoolSnapshot(connection, pool, mint, null);
  if (!snap0.ok) throw new Error(snap0.message);
  const reserveSol = Number(snap0.data.reserveSolRaw) / 1e9;
  const maxCf = poolSafeCf(reserveSol);
  const ltvs = [0.08, 0.12, Math.min(0.18, maxCf * 0.9)].map(
    v => Math.round(v * 1000) / 1000
  );
  console.log(
    JSON.stringify(
      { reserveSol, maxCf, ltvs, spot: snap0.data.spotPriceSol },
      null,
      2
    )
  );

  const results: Record<string, string> = {};

  for (const ltv of ltvs) {
    const kp = Keypair.generate();
    await fund(kp, 0.22);
    let snap = await fetchOmnipairPoolSnapshot(
      connection,
      pool,
      mint,
      kp.publicKey
    );
    if (!snap.ok) throw new Error(snap.message);
    await sendOmnipairSwapTx({
      connection,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      wallet: walletOf(kp) as any,
      snapshot: snap.data,
      side: "buy",
      amountUi: 0.05,
      slippagePercent: 12,
    });
    await new Promise(r => setTimeout(r, 1200));
    const tok = await tokBal(kp.publicKey);
    const coll = Math.min(tok * 0.2, 600);
    snap = await fetchOmnipairPoolSnapshot(
      connection,
      pool,
      mint,
      kp.publicKey
    );
    if (!snap.ok) throw new Error(snap.message);
    const collValueSol = coll * snap.data.spotPriceSol;
    const borrowSol = Math.min(collValueSol * ltv, reserveSol * 0.12);
    const key = `ltv@${(ltv * 100).toFixed(1)}%`;
    try {
      const res = await sendOmnipairBorrowAgainstProjectTx({
        connection,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        wallet: walletOf(kp) as any,
        snapshot: snap.data,
        collateralTokenUi: coll,
        borrowSolUi: borrowSol,
      });
      results[key] = `OK borrow=${borrowSol.toFixed(6)} sig=${res.borrowSig.slice(0, 10)}`;
      await upsertCanonicalTrade({
        mint,
        signature: res.borrowSig,
        side: "borrow",
        sol_amount_raw: BigInt(Math.floor(borrowSol * 1e9)).toString(),
        token_amount_raw: BigInt(Math.floor(coll * 1e6)).toString(),
        timestamp: new Date().toISOString(),
        wallet: kp.publicKey.toBase58(),
        price_sol: snap.data.spotPriceSol,
        source: "omnipair",
      });
    } catch (e) {
      results[key] =
        "FAIL " + (e instanceof Error ? e.message : String(e)).slice(0, 200);
    }
  }

  console.log(JSON.stringify(results, null, 2));
  const bad = Object.values(results).some(v => v.startsWith("FAIL"));
  process.exit(bad ? 1 : 0);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
