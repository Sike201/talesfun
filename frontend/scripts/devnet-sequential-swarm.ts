/**
 * Sequential multi-role swarm on the mint in talesfun-test-mint.json.
 * Avoids thin-pool races from Promise.all waves.
 *
 *   TRADERS=8 FUND_SOL=0.08 npx tsx --env-file=.env.local scripts/devnet-sequential-swarm.ts
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
import { poolMaxLeverage } from "../src/lib/poolMaxLeverage";
import { upsertCanonicalTrade } from "../src/lib/persistCanonicalTrade";

type Role = "buy" | "sell" | "long" | "short" | "borrow";

function walletOf(kp: Keypair) {
  return {
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
}

async function main() {
  const meta = JSON.parse(
    fs.readFileSync(".e2e-tmp/talesfun-test-mint.json", "utf8")
  ) as { mint: string; gammPool: string };
  const mint = meta.mint;
  const pool = meta.gammPool;
  const n = Math.max(4, Math.min(16, Number(process.env.TRADERS || "8")));
  const fundEach = Math.max(0.05, Number(process.env.FUND_SOL || "0.08"));

  const c = new Connection(
    process.env.NEXT_PUBLIC_SOLANA_RPC_URL || "https://api.devnet.solana.com",
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

  const roleCycle: Role[] = ["buy", "sell", "long", "short", "borrow", "buy", "sell", "long"];
  const traders = Array.from({ length: n }, (_, i) => ({
    i,
    role: roleCycle[i % roleCycle.length]!,
    kp: Keypair.generate(),
  }));

  const payerBal = (await c.getBalance(payer.publicKey)) / LAMPORTS_PER_SOL;
  const need = n * fundEach + 0.05;
  if (payerBal < need) {
    throw new Error(`payer has ${payerBal.toFixed(3)} SOL, need ≥ ${need.toFixed(2)}`);
  }

  console.log({ mint, pool, traders: n, fundEach, payerBal });

  for (const t of traders) {
    const tx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: payer.publicKey,
        toPubkey: t.kp.publicKey,
        lamports: Math.floor(fundEach * LAMPORTS_PER_SOL),
      })
    );
    await sendAndConfirmTransaction(c, tx, [payer], { commitment: "confirmed" });
  }

  fs.writeFileSync(
    ".e2e-tmp/fresh-sequential-traders.json",
    JSON.stringify(
      traders.map((t) => ({
        i: t.i,
        role: t.role,
        pubkey: t.kp.publicKey.toBase58(),
        secret: Array.from(t.kp.secretKey),
      })),
      null,
      2
    )
  );

  const results: { label: string; ok: boolean; detail: string }[] = [];

  for (const t of traders) {
    const label = `${t.role}#${t.i}`;
    try {
      let snap = await fetchOmnipairPoolSnapshot(c, pool, mint, t.kp.publicKey);
      if (!snap.ok) throw new Error(snap.message);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const wallet = walletOf(t.kp) as any;
      const reserveSol = Number(snap.data.reserveSolRaw) / 1e9;
      const maxLev = Math.min(poolMaxLeverage(reserveSol), 1.35);

      if (t.role === "buy") {
        const r = await sendOmnipairSwapTx({
          connection: c,
          wallet,
          snapshot: snap.data,
          side: "buy",
          amountUi: 0.012,
          slippagePercent: 28,
        });
        await upsertCanonicalTrade({
          mint,
          signature: r.signature,
          side: "buy",
          sol_amount_raw: String(Math.floor(0.012e9)),
          token_amount_raw: "0",
          timestamp: new Date().toISOString(),
          wallet: t.kp.publicKey.toBase58(),
          price_sol: snap.data.spotPriceSol,
          source: "omnipair",
        });
        results.push({ label, ok: true, detail: r.signature.slice(0, 12) });
      } else if (t.role === "sell") {
        const buy = await sendOmnipairSwapTx({
          connection: c,
          wallet,
          snapshot: snap.data,
          side: "buy",
          amountUi: 0.015,
          slippagePercent: 28,
        });
        snap = await fetchOmnipairPoolSnapshot(c, pool, mint, t.kp.publicKey);
        if (!snap.ok) throw new Error(snap.message);
        const ata = getAssociatedTokenAddressSync(
          new PublicKey(mint),
          t.kp.publicKey,
          true
        );
        const bal = await c.getTokenAccountBalance(ata);
        const ui = Number(bal.value.uiAmountString || "0") * 0.55;
        const sell = await sendOmnipairSwapTx({
          connection: c,
          wallet,
          snapshot: snap.data,
          side: "sell",
          amountUi: Math.max(ui, 1),
          slippagePercent: 40,
        });
        results.push({
          label,
          ok: true,
          detail: `${buy.signature.slice(0, 8)}/${sell.signature.slice(0, 8)}`,
        });
      } else if (t.role === "long") {
        await sendOmnipairSwapTx({
          connection: c,
          wallet,
          snapshot: snap.data,
          side: "buy",
          amountUi: 0.014,
          slippagePercent: 28,
        });
        snap = await fetchOmnipairPoolSnapshot(c, pool, mint, t.kp.publicKey);
        if (!snap.ok) throw new Error(snap.message);
        const res = await sendOmnipairLeverageStepTx({
          connection: c,
          wallet,
          snapshot: snap.data,
          direction: "long",
          marginUi: 0.008,
          leverage: maxLev,
          slippagePercent: 32,
        });
        results.push({
          label,
          ok: true,
          detail: res.sigs.at(-1)?.slice(0, 12) || "long",
        });
      } else if (t.role === "short") {
        const res = await sendOmnipairLeverageStepTx({
          connection: c,
          wallet,
          snapshot: snap.data,
          direction: "short",
          marginUi: 0.008,
          leverage: maxLev,
          slippagePercent: 32,
        });
        results.push({
          label,
          ok: true,
          detail: res.sigs.at(-1)?.slice(0, 12) || "short",
        });
      } else {
        await sendOmnipairSwapTx({
          connection: c,
          wallet,
          snapshot: snap.data,
          side: "buy",
          amountUi: 0.014,
          slippagePercent: 28,
        });
        snap = await fetchOmnipairPoolSnapshot(c, pool, mint, t.kp.publicKey);
        if (!snap.ok) throw new Error(snap.message);
        const ata = getAssociatedTokenAddressSync(
          new PublicKey(mint),
          t.kp.publicKey,
          true
        );
        const bal = await c.getTokenAccountBalance(ata);
        const collUi = Number(bal.value.uiAmountString || "0") * 0.7;
        const res = await sendOmnipairBorrowAgainstProjectTx({
          connection: c,
          wallet,
          snapshot: snap.data,
          collateralTokenUi: collUi,
          borrowSolUi: 0.003,
        });
        results.push({
          label,
          ok: true,
          detail: res.borrowSig.slice(0, 12),
        });
      }
      console.log("OK", label, results[results.length - 1]!.detail);
    } catch (e) {
      const msg =
        e instanceof Error ? e.message || e.name || "Error" : String(e);
      results.push({ label, ok: false, detail: msg.slice(0, 180) });
      console.log("FAIL", label, msg.slice(0, 140));
    }
  }

  const summary = {
    mint,
    pool,
    ok: results.filter((r) => r.ok).length,
    fail: results.filter((r) => !r.ok).length,
    results,
  };
  fs.writeFileSync(
    ".e2e-tmp/fresh-sequential-stats.json",
    JSON.stringify(summary, null, 2)
  );
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
