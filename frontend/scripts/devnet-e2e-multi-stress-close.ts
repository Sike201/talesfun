/**
 * Simultaneous multi-trader stress: buys/sells + long/short/borrow + close.
 * Adapts funding to payer balance (devnet faucet is often closed).
 *   npx tsx --env-file=.env.local scripts/devnet-e2e-multi-stress-close.ts
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
  fetchOmnipairUserPosition,
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
const OUT = path.join(ROOT, ".e2e-tmp/multi-stress-close-stats.json");

type Row = {
  role: string;
  ok: boolean;
  detail: string;
  sigs?: string[];
  ms: number;
};

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
    const lamports = Math.floor(sol * LAMPORTS_PER_SOL);
    if (lamports <= 0) return;
    const tx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: payer.publicKey,
        toPubkey: kp.publicKey,
        lamports,
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
  const payerBal =
    (await connection.getBalance(payer.publicKey)) / LAMPORTS_PER_SOL;

  // 3 concurrent traders is enough to stress borrow/lev/swap together.
  const perTrader = Math.min(0.065, Math.max(0.05, (payerBal - 0.02) / 3));
  console.log(
    JSON.stringify(
      {
        mint,
        pool,
        reserveSol,
        cf: poolSafeCf(reserveSol),
        maxLev,
        spot: snap0.data.spotPriceSol,
        payerBal,
        perTrader,
      },
      null,
      2
    )
  );

  const [tBuy, tLong, tShort] = [
    Keypair.generate(),
    Keypair.generate(),
    Keypair.generate(),
  ];
  for (const kp of [tBuy, tLong, tShort]) {
    await fund(kp, perTrader);
  }

  const rows: Row[] = [];
  const timed = async (role: string, fn: () => Promise<string[]>) => {
    const t0 = Date.now();
    try {
      const sigs = await fn();
      rows.push({
        role,
        ok: true,
        detail: `OK ${sigs.map(s => s.slice(0, 8)).join(",")}`,
        sigs,
        ms: Date.now() - t0,
      });
      console.log(`[ok] ${role}`, rows[rows.length - 1]!.detail);
    } catch (e) {
      const msg = (e instanceof Error ? e.message : String(e)).slice(0, 280);
      rows.push({ role, ok: false, detail: msg, ms: Date.now() - t0 });
      console.error(`[fail] ${role}`, msg);
    }
  };

  const buyUi = Math.min(0.018, perTrader * 0.28);
  const shortMargin = Math.min(0.008, perTrader * 0.12);

  // Wave 1 — simultaneous buy / buy-for-long / short
  await Promise.all([
    timed("buy-a", async () => {
      const snap = await fetchOmnipairPoolSnapshot(
        connection,
        pool,
        mint,
        tBuy.publicKey
      );
      if (!snap.ok) throw new Error(snap.message);
      const r = await sendOmnipairSwapTx({
        connection,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        wallet: walletOf(tBuy) as any,
        snapshot: snap.data,
        side: "buy",
        amountUi: buyUi,
        slippagePercent: 18,
      });
      await upsertCanonicalTrade({
        mint,
        signature: r.signature,
        side: "buy",
        sol_amount_raw: BigInt(Math.floor(buyUi * 1e9)).toString(),
        token_amount_raw: "0",
        timestamp: new Date().toISOString(),
        wallet: tBuy.publicKey.toBase58(),
        price_sol: snap.data.spotPriceSol,
        source: "omnipair",
      });
      return [r.signature];
    }),
    timed("buy-for-long", async () => {
      const snap = await fetchOmnipairPoolSnapshot(
        connection,
        pool,
        mint,
        tLong.publicKey
      );
      if (!snap.ok) throw new Error(snap.message);
      const r = await sendOmnipairSwapTx({
        connection,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        wallet: walletOf(tLong) as any,
        snapshot: snap.data,
        side: "buy",
        amountUi: buyUi * 1.1,
        slippagePercent: 18,
      });
      return [r.signature];
    }),
    timed("short-open", async () => {
      const snap = await fetchOmnipairPoolSnapshot(
        connection,
        pool,
        mint,
        tShort.publicKey
      );
      if (!snap.ok) throw new Error(snap.message);
      const res = await sendOmnipairLeverageStepTx({
        connection,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        wallet: walletOf(tShort) as any,
        snapshot: snap.data,
        direction: "short",
        marginUi: shortMargin,
        leverage: Math.min(maxLev, 1.25),
        slippagePercent: 22,
      });
      await upsertCanonicalTrade({
        mint,
        signature: res.sigs[res.sigs.length - 1]!,
        side: "short",
        sol_amount_raw: BigInt(Math.floor(shortMargin * 1e9)).toString(),
        token_amount_raw: "0",
        timestamp: new Date().toISOString(),
        wallet: tShort.publicKey.toBase58(),
        price_sol: snap.data.spotPriceSol,
        source: "omnipair",
      });
      return res.sigs;
    }),
  ]);

  await new Promise(r => setTimeout(r, 1800));

  // Wave 2 — long + borrow + sell simultaneously
  await Promise.all([
    timed("long-open", async () => {
      const tok = await tokBal(tLong.publicKey);
      const margin = Math.min(tok * 0.2, Math.max(40, tok * 0.1));
      if (!(margin > 0)) throw new Error(`no tokens for long (${tok})`);
      const snap = await fetchOmnipairPoolSnapshot(
        connection,
        pool,
        mint,
        tLong.publicKey
      );
      if (!snap.ok) throw new Error(snap.message);
      const res = await sendOmnipairLeverageStepTx({
        connection,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        wallet: walletOf(tLong) as any,
        snapshot: snap.data,
        direction: "long",
        marginUi: margin,
        leverage: Math.min(maxLev, 1.3),
        slippagePercent: 18,
      });
      await upsertCanonicalTrade({
        mint,
        signature: res.sigs[res.sigs.length - 1]!,
        side: "long",
        sol_amount_raw: BigInt(
          Math.floor(margin * snap.data.spotPriceSol * 1e9)
        ).toString(),
        token_amount_raw: BigInt(Math.floor(margin * 1e6)).toString(),
        timestamp: new Date().toISOString(),
        wallet: tLong.publicKey.toBase58(),
        price_sol: snap.data.spotPriceSol,
        source: "omnipair",
      });
      return res.sigs;
    }),
    timed("borrow-open", async () => {
      const tok = await tokBal(tBuy.publicKey);
      const coll = Math.min(tok * 0.25, 400);
      if (!(coll > 0)) throw new Error(`no tokens for borrow (${tok})`);
      const snap = await fetchOmnipairPoolSnapshot(
        connection,
        pool,
        mint,
        tBuy.publicKey
      );
      if (!snap.ok) throw new Error(snap.message);
      const res = await sendOmnipairBorrowAgainstProjectTx({
        connection,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        wallet: walletOf(tBuy) as any,
        snapshot: snap.data,
        collateralTokenUi: coll,
      });
      await upsertCanonicalTrade({
        mint,
        signature: res.borrowSig,
        side: "borrow",
        sol_amount_raw: "0",
        token_amount_raw: BigInt(Math.floor(coll * 1e6)).toString(),
        timestamp: new Date().toISOString(),
        wallet: tBuy.publicKey.toBase58(),
        price_sol: snap.data.spotPriceSol,
        source: "omnipair",
      });
      return [res.collateralSig, res.borrowSig];
    }),
    timed("sell-pressure", async () => {
      // Use leftover long-wallet tokens that weren't posted as margin.
      const tok = await tokBal(tLong.publicKey);
      const sell = tok * 0.15;
      if (!(sell > 1)) throw new Error(`nothing to sell (${tok})`);
      const snap = await fetchOmnipairPoolSnapshot(
        connection,
        pool,
        mint,
        tLong.publicKey
      );
      if (!snap.ok) throw new Error(snap.message);
      const r = await sendOmnipairSwapTx({
        connection,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        wallet: walletOf(tLong) as any,
        snapshot: snap.data,
        side: "sell",
        amountUi: sell,
        slippagePercent: 25,
      });
      await upsertCanonicalTrade({
        mint,
        signature: r.signature,
        side: "sell",
        sol_amount_raw: "0",
        token_amount_raw: BigInt(Math.floor(sell * 1e6)).toString(),
        timestamp: new Date().toISOString(),
        wallet: tLong.publicKey.toBase58(),
        price_sol: snap.data.spotPriceSol,
        source: "omnipair",
      });
      return [r.signature];
    }),
  ]);

  await new Promise(r => setTimeout(r, 2000));

  // Wave 3 — close all three positions concurrently
  const leftoverPayer =
    (await connection.getBalance(payer.publicKey)) / LAMPORTS_PER_SOL;
  const topUp = Math.min(0.025, Math.max(0, (leftoverPayer - 0.01) / 3));

  await Promise.all([
    timed("close-short", async () => {
      if (topUp > 0.002) await fund(tShort, topUp);
      const snap = await fetchOmnipairPoolSnapshot(
        connection,
        pool,
        mint,
        tShort.publicKey
      );
      if (!snap.ok) throw new Error(snap.message);
      const before = await fetchOmnipairUserPosition({
        connection,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        wallet: walletOf(tShort) as any,
        snapshot: snap.data,
      });
      if (!before) throw new Error("no short position on-chain");
      const res = await sendOmnipairClosePositionTx({
        connection,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        wallet: walletOf(tShort) as any,
        snapshot: snap.data,
        direction: "short",
        slippagePercent: 25,
      });
      const after = await fetchOmnipairUserPosition({
        connection,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        wallet: walletOf(tShort) as any,
        snapshot: snap.data,
      });
      if (
        after &&
        (after.debt0Raw > BigInt(0) ||
          after.debt1Raw > BigInt(0) ||
          after.collateral0 > BigInt(0) ||
          after.collateral1 > BigInt(0))
      ) {
        throw new Error(
          `short not fully closed d0=${after.debt0Raw} c0=${after.collateral0}`
        );
      }
      return res.sigs;
    }),
    timed("close-long", async () => {
      if (topUp > 0.002) await fund(tLong, topUp);
      const snap = await fetchOmnipairPoolSnapshot(
        connection,
        pool,
        mint,
        tLong.publicKey
      );
      if (!snap.ok) throw new Error(snap.message);
      const before = await fetchOmnipairUserPosition({
        connection,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        wallet: walletOf(tLong) as any,
        snapshot: snap.data,
      });
      if (!before) throw new Error("no long position on-chain");
      const res = await sendOmnipairClosePositionTx({
        connection,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        wallet: walletOf(tLong) as any,
        snapshot: snap.data,
        direction: "long",
        slippagePercent: 25,
      });
      return res.sigs;
    }),
    timed("close-borrow", async () => {
      if (topUp > 0.002) await fund(tBuy, topUp);
      const snap = await fetchOmnipairPoolSnapshot(
        connection,
        pool,
        mint,
        tBuy.publicKey
      );
      if (!snap.ok) throw new Error(snap.message);
      const before = await fetchOmnipairUserPosition({
        connection,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        wallet: walletOf(tBuy) as any,
        snapshot: snap.data,
      });
      if (!before) throw new Error("no borrow position on-chain");
      const res = await sendOmnipairClosePositionTx({
        connection,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        wallet: walletOf(tBuy) as any,
        snapshot: snap.data,
        direction: "borrow",
        slippagePercent: 25,
      });
      return res.sigs;
    }),
  ]);

  // Final concurrent buys to confirm pool still healthy
  const dust =
    (await connection.getBalance(payer.publicKey)) / LAMPORTS_PER_SOL;
  if (dust > 0.04) {
    await fund(tBuy, 0.015);
    await fund(tLong, 0.015);
    await Promise.all([
      timed("post-close-buy-a", async () => {
        const snap = await fetchOmnipairPoolSnapshot(
          connection,
          pool,
          mint,
          tBuy.publicKey
        );
        if (!snap.ok) throw new Error(snap.message);
        const r = await sendOmnipairSwapTx({
          connection,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          wallet: walletOf(tBuy) as any,
          snapshot: snap.data,
          side: "buy",
          amountUi: 0.01,
          slippagePercent: 18,
        });
        return [r.signature];
      }),
      timed("post-close-buy-b", async () => {
        const snap = await fetchOmnipairPoolSnapshot(
          connection,
          pool,
          mint,
          tLong.publicKey
        );
        if (!snap.ok) throw new Error(snap.message);
        const r = await sendOmnipairSwapTx({
          connection,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          wallet: walletOf(tLong) as any,
          snapshot: snap.data,
          side: "buy",
          amountUi: 0.01,
          slippagePercent: 18,
        });
        return [r.signature];
      }),
    ]);
  }

  const summary = {
    at: new Date().toISOString(),
    mint,
    pool,
    ok: rows.filter(r => r.ok).length,
    fail: rows.filter(r => !r.ok).length,
    rows,
  };
  fs.writeFileSync(OUT, JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
  process.exit(summary.fail > 0 ? 1 : 0);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
