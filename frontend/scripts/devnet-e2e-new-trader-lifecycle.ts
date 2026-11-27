/**
 * New-trader POV lifecycle — every trade type until something breaks.
 * buy → sell → long → close → short → close → borrow → close
 *
 *   npx tsx --env-file=.env.local scripts/devnet-e2e-new-trader-lifecycle.ts
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
  sendOmnipairClosePositionTx,
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
const OUT = path.join(ROOT, ".e2e-tmp/new-trader-lifecycle.json");

type Step = { step: string; ok: boolean; detail: string; ms: number };

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
  const steps: Step[] = [];

  const record = async (step: string, fn: () => Promise<string>) => {
    const t0 = Date.now();
    try {
      const detail = await fn();
      steps.push({ step, ok: true, detail, ms: Date.now() - t0 });
      console.log(`✓ ${step}: ${detail}`);
    } catch (e) {
      const detail = (e instanceof Error ? e.message : String(e)).slice(0, 280);
      steps.push({ step, ok: false, detail, ms: Date.now() - t0 });
      console.error(`✗ ${step}: ${detail}`);
      throw e;
    }
  };

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

  const snapFor = async (owner?: PublicKey) => {
    const snap = await fetchOmnipairPoolSnapshot(
      connection,
      pool,
      mint,
      owner ?? null
    );
    if (!snap.ok) throw new Error(snap.message);
    return snap.data;
  };

  const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

  const payerBal = await connection.getBalance(payer.publicKey);
  console.log(
    JSON.stringify(
      {
        payer: payer.publicKey.toBase58(),
        payerSol: payerBal / LAMPORTS_PER_SOL,
        mint,
        pool,
      },
      null,
      2
    )
  );

  const snap0 = await snapFor();
  const reserveSol = Number(snap0.reserveSolRaw) / 1e9;
  const maxLev = poolMaxLeverage(reserveSol);
  console.log(
    JSON.stringify(
      {
        reserveSol,
        cf: poolSafeCf(reserveSol),
        maxLev,
        spot: snap0.spotPriceSol,
        decimals: snap0.projectTokenDecimals,
      },
      null,
      2
    )
  );

  const trader = Keypair.generate();
  await fund(trader, 0.55);
  const w = walletOf(trader);

  // 1) Buy
  await record("buy", async () => {
    const snap = await snapFor(trader.publicKey);
    const res = await sendOmnipairSwapTx({
      connection,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      wallet: w as any,
      snapshot: snap,
      side: "buy",
      amountUi: 0.07,
      slippagePercent: 12,
    });
    await upsertCanonicalTrade({
      mint,
      signature: res.signature,
      side: "buy",
      sol_amount_raw: BigInt(Math.floor(0.07 * 1e9)).toString(),
      token_amount_raw: "0",
      timestamp: new Date().toISOString(),
      wallet: trader.publicKey.toBase58(),
      price_sol: snap.spotPriceSol,
      source: "omnipair",
    });
    await sleep(1200);
    const tok = await tokBal(trader.publicKey);
    return `${res.signature.slice(0, 12)} tok=${tok.toFixed(2)}`;
  });

  // 2) Sell partial
  await record("sell", async () => {
    const tok = await tokBal(trader.publicKey);
    if (!(tok > 0)) throw new Error("no tokens to sell");
    const sellAmt = Math.min(tok * 0.25, tok - 1);
    const snap = await snapFor(trader.publicKey);
    const res = await sendOmnipairSwapTx({
      connection,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      wallet: w as any,
      snapshot: snap,
      side: "sell",
      amountUi: sellAmt,
      slippagePercent: 12,
    });
    const dec = snap.projectTokenDecimals;
    await upsertCanonicalTrade({
      mint,
      signature: res.signature,
      side: "sell",
      sol_amount_raw: "0",
      token_amount_raw: BigInt(
        Math.floor(sellAmt * 10 ** dec)
      ).toString(),
      timestamp: new Date().toISOString(),
      wallet: trader.publicKey.toBase58(),
      price_sol: snap.spotPriceSol,
      source: "omnipair",
    });
    return `${res.signature.slice(0, 12)} sold=${sellAmt.toFixed(2)}`;
  });

  // 3) Long @ pool max
  await record("long@max", async () => {
    await sleep(800);
    const tok = await tokBal(trader.publicKey);
    const margin = Math.min(tok * 0.18, Math.max(120, tok * 0.06));
    if (!(margin > 0)) throw new Error(`insufficient margin tokens (${tok})`);
    const snap = await snapFor(trader.publicKey);
    const lev = poolMaxLeverage(Number(snap.reserveSolRaw) / 1e9);
    const res = await sendOmnipairLeverageStepTx({
      connection,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      wallet: w as any,
      snapshot: snap,
      direction: "long",
      marginUi: margin,
      leverage: lev,
      slippagePercent: 12,
    });
    await upsertCanonicalTrade({
      mint,
      signature: res.sigs[res.sigs.length - 1]!,
      side: "long",
      sol_amount_raw: BigInt(
        Math.floor(margin * snap.spotPriceSol * 1e9)
      ).toString(),
      token_amount_raw: BigInt(
        Math.floor(margin * 10 ** snap.projectTokenDecimals)
      ).toString(),
      timestamp: new Date().toISOString(),
      wallet: trader.publicKey.toBase58(),
      price_sol: snap.spotPriceSol,
      source: "omnipair",
    });
    return `${res.sigs.map(s => s.slice(0, 8)).join(",")} ${lev.toFixed(1)}x margin=${margin.toFixed(1)}`;
  });

  // 4) Close long
  await record("close-long", async () => {
    await sleep(1500);
    const snap = await snapFor(trader.publicKey);
    const res = await sendOmnipairClosePositionTx({
      connection,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      wallet: w as any,
      snapshot: snap,
      direction: "long",
    });
    return `${res.sigs.map(s => s.slice(0, 8)).join(",")} n=${res.sigs.length}`;
  });

  // 5) Short @ max (fresh SOL margin)
  await record("short@max", async () => {
    await sleep(800);
    const snap = await snapFor(trader.publicKey);
    const lev = poolMaxLeverage(Number(snap.reserveSolRaw) / 1e9);
    const res = await sendOmnipairLeverageStepTx({
      connection,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      wallet: w as any,
      snapshot: snap,
      direction: "short",
      marginUi: 0.014,
      leverage: lev,
      slippagePercent: 15,
    });
    await upsertCanonicalTrade({
      mint,
      signature: res.sigs[res.sigs.length - 1]!,
      side: "short",
      sol_amount_raw: BigInt(Math.floor(0.014 * 1e9)).toString(),
      token_amount_raw: "0",
      timestamp: new Date().toISOString(),
      wallet: trader.publicKey.toBase58(),
      price_sol: snap.spotPriceSol,
      source: "omnipair",
    });
    return `${res.sigs.map(s => s.slice(0, 8)).join(",")} ${lev.toFixed(1)}x`;
  });

  // 6) Close short
  await record("close-short", async () => {
    await sleep(1500);
    const snap = await snapFor(trader.publicKey);
    const res = await sendOmnipairClosePositionTx({
      connection,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      wallet: w as any,
      snapshot: snap,
      direction: "short",
    });
    return `${res.sigs.map(s => s.slice(0, 8)).join(",")} n=${res.sigs.length}`;
  });

  // 7) Borrow against tokens
  await record("borrow", async () => {
    await sleep(800);
    // Top up tokens if needed
    let tok = await tokBal(trader.publicKey);
    if (tok < 200) {
      const snapBuy = await snapFor(trader.publicKey);
      await sendOmnipairSwapTx({
        connection,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        wallet: w as any,
        snapshot: snapBuy,
        side: "buy",
        amountUi: 0.05,
        slippagePercent: 12,
      });
      await sleep(1200);
      tok = await tokBal(trader.publicKey);
    }
    const coll = Math.min(tok * 0.22, 900);
    const snap = await snapFor(trader.publicKey);
    const res = await sendOmnipairBorrowAgainstProjectTx({
      connection,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      wallet: w as any,
      snapshot: snap,
      collateralTokenUi: coll,
    });
    await upsertCanonicalTrade({
      mint,
      signature: res.borrowSig,
      side: "borrow",
      sol_amount_raw: "0",
      token_amount_raw: BigInt(
        Math.floor(coll * 10 ** snap.projectTokenDecimals)
      ).toString(),
      timestamp: new Date().toISOString(),
      wallet: trader.publicKey.toBase58(),
      price_sol: snap.spotPriceSol,
      source: "omnipair",
    });
    return `${res.borrowSig.slice(0, 12)} coll=${coll.toFixed(1)}`;
  });

  // 8) Close borrow
  await record("close-borrow", async () => {
    await sleep(1500);
    const snap = await snapFor(trader.publicKey);
    const res = await sendOmnipairClosePositionTx({
      connection,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      wallet: w as any,
      snapshot: snap,
      direction: "borrow",
    });
    return `${res.sigs.map(s => s.slice(0, 8)).join(",")} n=${res.sigs.length}`;
  });

  const summary = {
    trader: trader.publicKey.toBase58(),
    ok: steps.every(s => s.ok),
    steps,
    at: new Date().toISOString(),
  };
  fs.writeFileSync(OUT, JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
  process.exit(summary.ok ? 0 : 1);
}

main().catch(e => {
  const payload = {
    ok: false,
    error: e instanceof Error ? e.message : String(e),
    at: new Date().toISOString(),
  };
  fs.writeFileSync(OUT, JSON.stringify(payload, null, 2));
  console.error(e);
  process.exit(1);
});
