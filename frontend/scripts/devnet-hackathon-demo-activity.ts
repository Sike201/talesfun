/**
 * Post-graduation hackathon demo activity on talesfun-test-mint.json:
 * buy-heavy swaps, long-heavy leverage, shorts, borrows, max-leverage probes,
 * fee-wallet delta checks, and a proof JSON for the recording.
 *
 *   TRADERS=12 FUND_SOL=0.18 ROUNDS=3 \
 *     npx tsx --env-file=.env.local scripts/devnet-hackathon-demo-activity.ts
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
import {
  graduatedLiquidityUsd,
  marketCapUsdFromSpot,
  mcapToLiquidityRatio,
  isThinLiquidity,
} from "../src/lib/marketStats";
import {
  getReadOnlyProgram,
  getTokenStatePDA,
  tokenStateToToken,
} from "../src/lib/program";

type Role = "buy" | "buy" | "sell" | "long" | "long" | "short" | "borrow" | "maxlev";

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

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const meta = JSON.parse(
    fs.readFileSync(".e2e-tmp/talesfun-test-mint.json", "utf8")
  ) as { mint: string; gammPool?: string };
  const mint = meta.mint;
  const c = new Connection(
    process.env.NEXT_PUBLIC_SOLANA_RPC_URL || "https://api.devnet.solana.com",
    "confirmed"
  );

  // Refresh gamm pool from chain
  const program = getReadOnlyProgram(c);
  const [pda] = getTokenStatePDA(new PublicKey(mint));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const state = await (program.account as any).tokenState.fetch(pda);
  const t0 = tokenStateToToken(state, mint);
  if (!t0.gammPool) throw new Error("not bootstrapped");
  const pool = t0.gammPool;
  meta.gammPool = pool;
  fs.writeFileSync(".e2e-tmp/talesfun-test-mint.json", JSON.stringify(meta, null, 2));

  const n = Math.max(3, Math.min(16, Number(process.env.TRADERS || "12")));
  const fundEach = Math.max(0.05, Number(process.env.FUND_SOL || "0.18"));
  const rounds = Math.max(1, Math.min(6, Number(process.env.ROUNDS || "3")));

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
  const feePk = new PublicKey(
    process.env.NEXT_PUBLIC_PLATFORM_FEE_WALLET ||
      "Dxyvgga3t9eF7b3CggCxejpkx6MbX7e3AGdKKaMVAtng"
  );
  const feeBefore = await c.getBalance(feePk);

  // Buy-heavy / long-heavy role mix
  const roleCycle: Role[] = [
    "buy",
    "buy",
    "long",
    "sell",
    "buy",
    "long",
    "borrow",
    "short",
    "buy",
    "maxlev",
    "long",
    "buy",
  ];
  const traders = Array.from({ length: n }, (_, i) => ({
    i,
    role: roleCycle[i % roleCycle.length]!,
    kp: Keypair.generate(),
  }));

  const payerBal = (await c.getBalance(payer.publicKey)) / LAMPORTS_PER_SOL;
  const need = n * fundEach + 0.08;
  if (payerBal < need) {
    throw new Error(`EXC has ${payerBal.toFixed(3)} SOL, need ≥ ${need.toFixed(2)}`);
  }
  console.log({ mint, pool, traders: n, fundEach, rounds, payerBal, feeBefore: feeBefore / 1e9 });

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
    ".e2e-tmp/hackathon-demo-traders.json",
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

  const counts = {
    buy: 0,
    sell: 0,
    long: 0,
    short: 0,
    borrow: 0,
    maxlev: 0,
    ok: 0,
    fail: 0,
  };
  const results: { label: string; ok: boolean; detail: string }[] = [];
  let maxLevObserved = 0;

  for (let round = 1; round <= rounds; round++) {
    console.log(`\n=== demo round ${round}/${rounds} ===`);
    for (const t of traders) {
      const label = `r${round}-${t.role}#${t.i}`;
      try {
        let snap = await fetchOmnipairPoolSnapshot(c, pool, mint, t.kp.publicKey);
        if (!snap.ok) throw new Error(snap.message);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const wallet = walletOf(t.kp) as any;
        const reserveSol = Number(snap.data.reserveSolRaw) / 1e9;
        const maxLev = Math.min(poolMaxLeverage(reserveSol), 2.2);
        maxLevObserved = Math.max(maxLevObserved, maxLev);

        if (t.role === "buy") {
          const amt = 0.012 + Math.random() * 0.02;
          const r = await sendOmnipairSwapTx({
            connection: c,
            wallet,
            snapshot: snap.data,
            side: "buy",
            amountUi: amt,
            slippagePercent: 30,
          });
          await upsertCanonicalTrade({
            mint,
            signature: r.signature,
            side: "buy",
            sol_amount_raw: String(Math.floor(amt * 1e9)),
            token_amount_raw: "0",
            timestamp: new Date().toISOString(),
            wallet: t.kp.publicKey.toBase58(),
            price_sol: snap.data.spotPriceSol,
            source: "omnipair",
          });
          counts.buy++;
          results.push({ label, ok: true, detail: r.signature.slice(0, 12) });
        } else if (t.role === "sell") {
          await sendOmnipairSwapTx({
            connection: c,
            wallet,
            snapshot: snap.data,
            side: "buy",
            amountUi: 0.018,
            slippagePercent: 30,
          });
          snap = await fetchOmnipairPoolSnapshot(c, pool, mint, t.kp.publicKey);
          if (!snap.ok) throw new Error(snap.message);
          const ata = getAssociatedTokenAddressSync(
            new PublicKey(mint),
            t.kp.publicKey,
            true
          );
          const bal = await c.getTokenAccountBalance(ata);
          const ui = Number(bal.value.uiAmountString || "0") * 0.45;
          if (ui > 1) {
            const sell = await sendOmnipairSwapTx({
              connection: c,
              wallet,
              snapshot: snap.data,
              side: "sell",
              amountUi: ui,
              slippagePercent: 35,
            });
            counts.sell++;
            results.push({
              label,
              ok: true,
              detail: `${sell.signature.slice(0, 8)}/${ui.toFixed(0)}`,
            });
          } else {
            counts.buy++;
            results.push({ label, ok: true, detail: "buy-only-dust" });
          }
        } else if (t.role === "long" || t.role === "maxlev") {
          await sendOmnipairSwapTx({
            connection: c,
            wallet,
            snapshot: snap.data,
            side: "buy",
            amountUi: 0.014,
            slippagePercent: 30,
          });
          snap = await fetchOmnipairPoolSnapshot(c, pool, mint, t.kp.publicKey);
          if (!snap.ok) throw new Error(snap.message);
          const lev =
            t.role === "maxlev"
              ? maxLev
              : Math.min(maxLev, 1.15 + Math.random() * 0.35);
          const margin = Math.min(0.012 + Math.random() * 0.01, fundEach * 0.25);
          const r = await sendOmnipairLeverageStepTx({
            connection: c,
            wallet,
            snapshot: snap.data,
            direction: "long",
            marginUi: margin,
            leverage: lev,
            slippagePercent: 35,
          });
          counts.long++;
          if (t.role === "maxlev") counts.maxlev++;
          results.push({
            label,
            ok: true,
            detail: `lev=${lev.toFixed(2)} ${r.sigs.at(-1)?.slice(0, 10) || "long"}`,
          });
        } else if (t.role === "short") {
          const lev = Math.min(maxLev, 1.25);
          const r = await sendOmnipairLeverageStepTx({
            connection: c,
            wallet,
            snapshot: snap.data,
            direction: "short",
            marginUi: Math.min(0.01, fundEach * 0.2),
            leverage: lev,
            slippagePercent: 35,
          });
          counts.short++;
          results.push({
            label,
            ok: true,
            detail: `lev=${lev.toFixed(2)} ${r.sigs.at(-1)?.slice(0, 10) || "short"}`,
          });
        } else if (t.role === "borrow") {
          await sendOmnipairSwapTx({
            connection: c,
            wallet,
            snapshot: snap.data,
            side: "buy",
            amountUi: 0.015,
            slippagePercent: 30,
          });
          snap = await fetchOmnipairPoolSnapshot(c, pool, mint, t.kp.publicKey);
          if (!snap.ok) throw new Error(snap.message);
          const ata = getAssociatedTokenAddressSync(
            new PublicKey(mint),
            t.kp.publicKey,
            true
          );
          const bal = await c.getTokenAccountBalance(ata);
          const tok = Number(bal.value.uiAmountString || "0");
          const coll = tok * 0.7;
          if (coll > 10) {
            const r = await sendOmnipairBorrowAgainstProjectTx({
              connection: c,
              wallet,
              snapshot: snap.data,
              collateralTokenUi: coll,
              borrowSolUi: Math.min(0.006, reserveSol * 0.015),
            });
            counts.borrow++;
            results.push({ label, ok: true, detail: r.borrowSig.slice(0, 12) });
          } else {
            counts.buy++;
            results.push({ label, ok: true, detail: "borrow-skipped" });
          }
        }
        counts.ok++;
        console.log("OK", label);
      } catch (e) {
        counts.fail++;
        const msg = e instanceof Error ? e.message.slice(0, 140) : String(e);
        results.push({ label, ok: false, detail: msg });
        console.log("FAIL", label, msg);
      }
      await sleep(400);
    }
  }

  const feeAfter = await c.getBalance(feePk);
  const supply = await c.getTokenSupply(new PublicKey(mint));
  const snapF = await fetchOmnipairPoolSnapshot(c, pool, mint, null);
  let solUsd = 140;
  try {
    const j = (await (
      await fetch(
        "https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd"
      )
    ).json()) as { solana?: { usd?: number } };
    if (j.solana?.usd) solUsd = j.solana.usd;
  } catch {
    /* */
  }

  const mintUi = supply.value.uiAmount ?? 0;
  const poolSol = snapF.ok ? Number(snapF.data.reserveSolRaw) / 1e9 : 0;
  const spot = snapF.ok ? snapF.data.spotPriceSol : 0;
  const mcap = marketCapUsdFromSpot({
    spotSol: spot,
    totalSupply: mintUi,
    solUsd,
  });
  const liq = graduatedLiquidityUsd({ reserveSol: poolSol, solUsd });

  const proof = {
    at: new Date().toISOString(),
    mint,
    pool,
    page: `http://localhost:3000/token/${mint}`,
    graduationSol: process.env.NEXT_PUBLIC_GRADUATION_SOL || "5",
    activity: counts,
    buyVsSell: { buys: counts.buy, sells: counts.sell },
    longVsShort: { longs: counts.long, shorts: counts.short },
    maxLevObserved,
    fees: {
      feeWallet: feePk.toBase58(),
      beforeSol: feeBefore / LAMPORTS_PER_SOL,
      afterSol: feeAfter / LAMPORTS_PER_SOL,
      deltaSol: (feeAfter - feeBefore) / LAMPORTS_PER_SOL,
      feesReceived: feeAfter > feeBefore,
    },
    market: {
      mintSupplyUi: mintUi,
      poolSol,
      spot,
      solUsd,
      mcapUsd: Math.round(mcap),
      liqUsd: Math.round(liq),
      mcapToLiq: mcapToLiquidityRatio(mcap, liq),
      thin: isThinLiquidity(mcap, liq),
    },
    results,
    ok: counts.fail === 0 || counts.ok >= counts.fail * 2,
  };

  fs.writeFileSync(
    ".e2e-tmp/hackathon-demo-proof.json",
    JSON.stringify(proof, null, 2)
  );
  console.log(JSON.stringify(proof, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
