/**
 * New-trader POV: fresh wallets → buy → long@poolMax / short@poolMax / borrow.
 *   npx tsx --env-file=.env.local scripts/devnet-e2e-fresh-trader.ts
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
import {
  sendOmnipairBorrowAgainstProjectTx,
  sendOmnipairLeverageStepTx,
} from "../src/lib/omnipairLending";
import { poolMaxLeverage, poolSafeCf } from "../src/lib/poolMaxLeverage";
import { upsertCanonicalTrade } from "../src/lib/persistCanonicalTrade";

const ROOT = path.resolve(__dirname, "..");
const meta = JSON.parse(
  fs.readFileSync(path.join(ROOT, ".e2e-tmp/talesfun-test-mint.json"), "utf8")
) as { mint: string; gammPool: string };
const RPC =
  process.env.NEXT_PUBLIC_SOLANA_RPC_URL || "https://api.devnet.solana.com";
const mint = meta.mint;
const pool = meta.gammPool;

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
  const phantom = JSON.parse(
    fs.readFileSync(
      path.join(process.env.HOME!, ".config/solana/phantom.json"),
      "utf8"
    )
  ) as number[];
  const payer = Keypair.fromSecretKey(Uint8Array.from(phantom));
  const connection = new Connection(RPC, "confirmed");

  const fund = async (kp: Keypair, sol: number) => {
    const tx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: payer.publicKey,
        toPubkey: kp.publicKey,
        lamports: Math.floor(sol * LAMPORTS_PER_SOL),
      })
    );
    await sendAndConfirmTransaction(connection, tx, [payer], {
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
  const maxLev = poolMaxLeverage(reserveSol);
  console.log(
    JSON.stringify(
      {
        reserveSol,
        cf: poolSafeCf(reserveSol),
        maxLev,
        spot: snap0.data.spotPriceSol,
      },
      null,
      2
    )
  );

  const results: Record<string, string> = {};

  // Long @ Max
  {
    const kp = Keypair.generate();
    await fund(kp, 0.28);
    const snap = await fetchOmnipairPoolSnapshot(
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
      amountUi: 0.08,
      slippagePercent: 12,
    });
    await new Promise(r => setTimeout(r, 1500));
    const tok = await tokBal(kp.publicKey);
    const margin = Math.min(tok * 0.2, Math.max(150, tok * 0.08));
    console.log("long inventory", tok, "margin", margin);
    const snap2 = await fetchOmnipairPoolSnapshot(
      connection,
      pool,
      mint,
      kp.publicKey
    );
    if (!snap2.ok) throw new Error(snap2.message);
    try {
      const res = await sendOmnipairLeverageStepTx({
        connection,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        wallet: walletOf(kp) as any,
        snapshot: snap2.data,
        direction: "long",
        marginUi: margin,
        leverage: maxLev,
        slippagePercent: 12,
      });
      results["long@max"] = `OK ${res.sigs.map(s => s.slice(0, 8)).join(",")}`;
      await upsertCanonicalTrade({
        mint,
        signature: res.sigs[res.sigs.length - 1]!,
        side: "long",
        sol_amount_raw: BigInt(
          Math.floor(margin * snap2.data.spotPriceSol * 1e9)
        ).toString(),
        token_amount_raw: BigInt(Math.floor(margin * 1e6)).toString(),
        timestamp: new Date().toISOString(),
        wallet: kp.publicKey.toBase58(),
        price_sol: snap2.data.spotPriceSol,
        source: "omnipair",
      });
    } catch (e) {
      results["long@max"] =
        "FAIL " + (e instanceof Error ? e.message : String(e)).slice(0, 200);
    }
  }

  // Short @ Max
  {
    const kp = Keypair.generate();
    await fund(kp, 0.22);
    const snap = await fetchOmnipairPoolSnapshot(
      connection,
      pool,
      mint,
      kp.publicKey
    );
    if (!snap.ok) throw new Error(snap.message);
    try {
      const res = await sendOmnipairLeverageStepTx({
        connection,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        wallet: walletOf(kp) as any,
        snapshot: snap.data,
        direction: "short",
        marginUi: 0.012,
        leverage: maxLev,
        slippagePercent: 15,
      });
      results["short@max"] = `OK ${res.sigs.map(s => s.slice(0, 8)).join(",")}`;
      await upsertCanonicalTrade({
        mint,
        signature: res.sigs[res.sigs.length - 1]!,
        side: "short",
        sol_amount_raw: BigInt(Math.floor(0.012 * 1e9)).toString(),
        token_amount_raw: "0",
        timestamp: new Date().toISOString(),
        wallet: kp.publicKey.toBase58(),
        price_sol: snap.data.spotPriceSol,
        source: "omnipair",
      });
    } catch (e) {
      results["short@max"] =
        "FAIL " + (e instanceof Error ? e.message : String(e)).slice(0, 200);
    }
  }

  // Borrow
  {
    const kp = Keypair.generate();
    await fund(kp, 0.25);
    const snap = await fetchOmnipairPoolSnapshot(
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
      amountUi: 0.06,
      slippagePercent: 12,
    });
    await new Promise(r => setTimeout(r, 1500));
    const tok = await tokBal(kp.publicKey);
    const coll = Math.min(tok * 0.25, 800);
    const snap2 = await fetchOmnipairPoolSnapshot(
      connection,
      pool,
      mint,
      kp.publicKey
    );
    if (!snap2.ok) throw new Error(snap2.message);
    try {
      const res = await sendOmnipairBorrowAgainstProjectTx({
        connection,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        wallet: walletOf(kp) as any,
        snapshot: snap2.data,
        collateralTokenUi: coll,
      });
      results.borrow = `OK ${res.borrowSig.slice(0, 12)}`;
      await upsertCanonicalTrade({
        mint,
        signature: res.borrowSig,
        side: "borrow",
        sol_amount_raw: "0",
        token_amount_raw: BigInt(Math.floor(coll * 1e6)).toString(),
        timestamp: new Date().toISOString(),
        wallet: kp.publicKey.toBase58(),
        price_sol: snap2.data.spotPriceSol,
        source: "omnipair",
      });
    } catch (e) {
      results.borrow =
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
