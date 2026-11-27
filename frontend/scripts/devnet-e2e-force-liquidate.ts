/**
 * Force liquidation via self-dump:
 * victim buys → posts ~55% as collateral + max borrow → dumps remaining ~45% into the pool
 * (asymmetric sell pressure) → liquidator seizes from a separate wallet.
 *
 *   npx tsx --env-file=.env.local scripts/devnet-e2e-force-liquidate.ts
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
  sendOmnipairLiquidateTx,
} from "../src/lib/omnipairLending";
import { poolSafeCf } from "../src/lib/poolMaxLeverage";
import { riskFromOnChainPosition } from "../src/lib/positionMetrics";

const ROOT = path.resolve(__dirname, "..");
const meta = JSON.parse(
  fs.readFileSync(path.join(ROOT, ".e2e-tmp/talesfun-test-mint.json"), "utf8")
) as { mint: string; gammPool: string };
const OUT = path.join(ROOT, ".e2e-tmp/force-liquidate-proof.json");
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
  const exc = Keypair.fromSecretKey(
    Uint8Array.from(
      JSON.parse(
        fs.readFileSync(
          path.join(process.env.HOME!, ".config/solana/phantom.json"),
          "utf8"
        )
      )
    )
  );
  const connection = new Connection(RPC, "confirmed");
  const mint = meta.mint;
  const pool = meta.gammPool;
  const mintPk = new PublicKey(mint);

  const fund = async (kp: Keypair, sol: number) => {
    const tx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: exc.publicKey,
        toPubkey: kp.publicKey,
        lamports: Math.floor(sol * LAMPORTS_PER_SOL),
      })
    );
    await sendAndConfirmTransaction(connection, tx, [exc], {
      commitment: "confirmed",
    });
  };

  const tokBal = async (owner: PublicKey) => {
    try {
      const ata = getAssociatedTokenAddressSync(mintPk, owner, true);
      return Number(
        (await connection.getTokenAccountBalance(ata)).value.uiAmountString ||
          "0"
      );
    } catch {
      return 0;
    }
  };

  const snapFor = async (owner?: PublicKey) => {
    const s = await fetchOmnipairPoolSnapshot(
      connection,
      pool,
      mint,
      owner ?? null
    );
    if (!s.ok) throw new Error(s.message);
    return s.data;
  };

  const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

  const victim = Keypair.generate();
  const liquidator = Keypair.generate();
  const helper = Keypair.generate();

  const readRisk = async (owner: PublicKey) => {
    const snap = await snapFor();
    const view = await fetchOmnipairUserPosition({
      connection,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      wallet: walletOf(liquidator) as any,
      snapshot: snap,
      owner,
    });
    if (!view) return null;
    const cf = poolSafeCf(Number(snap.reserveSolRaw) / 1e9);
    const risk = riskFromOnChainPosition({
      pos: view,
      projectMint: snap.projectMint,
      projectDecimals: snap.projectTokenDecimals,
      spotSol: snap.spotPriceSol,
      solUsd: 140,
      fallbackLiqLtv: Math.max(cf, 0.2),
    });
    return { snap, view, risk, cf };
  };

  const excBal = (await connection.getBalance(exc.publicKey)) / 1e9;
  console.log({ excBal, victim: victim.publicKey.toBase58() });
  if (excBal < 1.0) throw new Error(`EXC low (${excBal})`);

  await fund(victim, 0.55);
  await fund(liquidator, 0.1);
  await fund(helper, Math.min(0.7, excBal * 0.2));

  // Large buy so free inventory dump can move the thin pool.
  {
    const snap = await snapFor(victim.publicKey);
    await sendOmnipairSwapTx({
      connection,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      wallet: walletOf(victim) as any,
      snapshot: snap,
      side: "buy",
      amountUi: 0.22,
      slippagePercent: 25,
    });
    await sleep(1200);
  }

  const tok0 = await tokBal(victim.publicKey);
  // Post only ~50% as collateral — keep rest free to dump.
  const coll = tok0 * 0.5;
  const free = tok0 - coll;
  const snapB = await snapFor(victim.publicKey);
  const cf = poolSafeCf(Number(snapB.reserveSolRaw) / 1e9);
  const borrowSolUi = coll * snapB.spotPriceSol * Math.min(0.98, cf * 0.98);
  await sendOmnipairBorrowAgainstProjectTx({
    connection,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    wallet: walletOf(victim) as any,
    snapshot: snapB,
    collateralTokenUi: coll,
    borrowSolUi,
  });
  console.log("opened", { tok0, coll, free, borrowSolUi, cf });

  let before = await readRisk(victim.publicKey);
  console.log("risk before dump", {
    ltv: before?.risk.ltv,
    toLiq: before?.risk.toLiquidationPct,
    spot: before?.snap.spotPriceSol,
  });

  // Self-dump free inventory (asymmetric sell).
  {
    const have = await tokBal(victim.publicKey);
    if (have > 10) {
      const snap = await snapFor(victim.publicKey);
      await sendOmnipairSwapTx({
        connection,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        wallet: walletOf(victim) as any,
        snapshot: snap,
        side: "sell",
        amountUi: have * 0.99,
        slippagePercent: 45,
      });
      console.log("self-dumped", have);
    }
  }
  await sleep(1000);

  // Helper adds more sell pressure (buy once, then dump hard).
  {
    const snap = await snapFor(helper.publicKey);
    const buyAmt = Math.min(
      0.35,
      ((await connection.getBalance(helper.publicKey)) / 1e9) * 0.6
    );
    await sendOmnipairSwapTx({
      connection,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      wallet: walletOf(helper) as any,
      snapshot: snap,
      side: "buy",
      amountUi: buyAmt,
      slippagePercent: 35,
    });
    await sleep(1000);
    const tok = await tokBal(helper.publicKey);
    const snap2 = await snapFor(helper.publicKey);
    await sendOmnipairSwapTx({
      connection,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      wallet: walletOf(helper) as any,
      snapshot: snap2,
      side: "sell",
      amountUi: tok * 0.99,
      slippagePercent: 50,
    });
    // Second helper dump from EXC-sized buy if still healthy
    await sleep(800);
  }

  let liquidated: string | null = null;
  let last: Awaited<ReturnType<typeof readRisk>> = null;
  for (let i = 0; i < 6 && !liquidated; i++) {
    last = await readRisk(victim.publicKey);
    console.log(`attempt ${i}`, {
      ltv: last?.risk.ltv,
      toLiq: last?.risk.toLiquidationPct,
      spot: last?.snap.spotPriceSol,
      debtUsd: last?.risk.debtUsd,
      collUsd: last?.risk.collateralUsd,
    });
    if (!last) throw new Error("position gone");

    try {
      const r = await sendOmnipairLiquidateTx({
        connection,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        wallet: walletOf(liquidator) as any,
        snapshot: last.snap,
        positionOwner: victim.publicKey,
        collateralMint: last.snap.projectMint,
      });
      liquidated = r.signature;
      console.log("LIQUIDATED", r.signature);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn("liquidate:", msg.slice(0, 180));
      // Extra dump pressure from helper leftovers / rebuy-sell
      if (/0x178d|NotUndercollateralized/i.test(msg)) {
        const snap = await snapFor(helper.publicKey);
        const bal = (await connection.getBalance(helper.publicKey)) / 1e9;
        if (bal > 0.05) {
          try {
            await sendOmnipairSwapTx({
              connection,
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              wallet: walletOf(helper) as any,
              snapshot: snap,
              side: "buy",
              amountUi: Math.min(0.12, bal * 0.5),
              slippagePercent: 40,
            });
            await sleep(700);
            const t = await tokBal(helper.publicKey);
            const snap2 = await snapFor(helper.publicKey);
            await sendOmnipairSwapTx({
              connection,
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              wallet: walletOf(helper) as any,
              snapshot: snap2,
              side: "sell",
              amountUi: t * 0.99,
              slippagePercent: 55,
            });
          } catch (dumpErr) {
            console.warn(
              "extra dump failed",
              dumpErr instanceof Error ? dumpErr.message.slice(0, 100) : dumpErr
            );
          }
        }
        await sleep(800);
      } else {
        throw e;
      }
    }
  }

  const proof = {
    ok: Boolean(liquidated),
    liquidated,
    before: before
      ? {
          ltv: before.risk.ltv,
          toLiq: before.risk.toLiquidationPct,
          spot: before.snap.spotPriceSol,
        }
      : null,
    after: last
      ? {
          ltv: last.risk.ltv,
          toLiq: last.risk.toLiquidationPct,
          spot: last.snap.spotPriceSol,
          debtUsd: last.risk.debtUsd,
          collUsd: last.risk.collateralUsd,
        }
      : null,
    victim: victim.publicKey.toBase58(),
    liquidator: liquidator.publicKey.toBase58(),
    note: liquidated
      ? "Liquidate IX succeeded — position was undercollateralized"
      : "Liquidate IX correctly rejects healthy positions (NotUndercollateralized). Need larger price move vs locked CF.",
    at: new Date().toISOString(),
  };
  fs.writeFileSync(OUT, JSON.stringify(proof, null, 2));
  console.log(JSON.stringify(proof, null, 2));
  process.exit(proof.ok ? 0 : 1);
}

main().catch(e => {
  fs.writeFileSync(
    OUT,
    JSON.stringify(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      null,
      2
    )
  );
  console.error(e);
  process.exit(1);
});
