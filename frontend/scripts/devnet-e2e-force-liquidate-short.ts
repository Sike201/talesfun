/**
 * Force-liquidate a SHORT by pumping the token (buy pressure, no round-trip).
 *   npx tsx --env-file=.env.local scripts/devnet-e2e-force-liquidate-short.ts
 */
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
import { NATIVE_MINT } from "@solana/spl-token";
import { fetchOmnipairPoolSnapshot } from "../src/lib/omnipairPoolState";
import { sendOmnipairSwapTx } from "../src/lib/omnipairSwap";
import {
  fetchOmnipairUserPosition,
  sendOmnipairLeverageStepTx,
  sendOmnipairLiquidateTx,
} from "../src/lib/omnipairLending";
import { poolMaxLeverage, poolSafeCf } from "../src/lib/poolMaxLeverage";
import { riskFromOnChainPosition } from "../src/lib/positionMetrics";

const ROOT = path.resolve(__dirname, "..");
const meta = JSON.parse(
  fs.readFileSync(path.join(ROOT, ".e2e-tmp/talesfun-test-mint.json"), "utf8")
) as { mint: string; gammPool: string };
const OUT = path.join(ROOT, ".e2e-tmp/force-liquidate-short-proof.json");
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

  const snapFor = async (owner?: Parameters<typeof fetchOmnipairPoolSnapshot>[3]) => {
    const s = await fetchOmnipairPoolSnapshot(connection, pool, mint, owner ?? null);
    if (!s.ok) throw new Error(s.message);
    return s.data;
  };

  const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

  const victim = Keypair.generate();
  const liquidator = Keypair.generate();
  const pumpers = [Keypair.generate(), Keypair.generate(), Keypair.generate()];

  const excBal = (await connection.getBalance(exc.publicKey)) / 1e9;
  console.log({ excBal });
  if (excBal < 0.9) throw new Error(`EXC low ${excBal}`);

  await fund(victim, 0.28);
  await fund(liquidator, 0.08);
  const perPump = Math.min(0.28, Math.max(0.12, (excBal - 0.55) / (pumpers.length + 1)));
  for (const p of pumpers) await fund(p, perPump);

  const snap0 = await snapFor(victim.publicKey);
  const lev = poolMaxLeverage(Number(snap0.reserveSolRaw) / 1e9);
  const short = await sendOmnipairLeverageStepTx({
    connection,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    wallet: walletOf(victim) as any,
    snapshot: snap0,
    direction: "short",
    marginUi: 0.04,
    leverage: lev,
    slippagePercent: 25,
  });
  console.log("short opened", short.sigs);

  let liquidated: string | null = null;
  let lastRisk: Record<string, unknown> | null = null;

  for (let round = 0; round < pumpers.length + 2 && !liquidated; round++) {
    // Pure buy pressure — do NOT sell back.
    const pumper = pumpers[Math.min(round, pumpers.length - 1)]!;
    const bal = (await connection.getBalance(pumper.publicKey)) / 1e9;
    const buyAmt = Math.min(0.18, bal * 0.75);
    if (buyAmt > 0.02) {
      const snap = await snapFor(pumper.publicKey);
      await sendOmnipairSwapTx({
        connection,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        wallet: walletOf(pumper) as any,
        snapshot: snap,
        side: "buy",
        amountUi: buyAmt,
        slippagePercent: 40,
      });
      console.log(`pump ${round} bought`, buyAmt);
    }
    await sleep(1000);

    const snapR = await snapFor();
    const view = await fetchOmnipairUserPosition({
      connection,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      wallet: walletOf(liquidator) as any,
      snapshot: snapR,
      owner: victim.publicKey,
    });
    if (!view) throw new Error("no position");
    const cf = poolSafeCf(Number(snapR.reserveSolRaw) / 1e9);
    const risk = riskFromOnChainPosition({
      pos: view,
      projectMint: snapR.projectMint,
      projectDecimals: snapR.projectTokenDecimals,
      spotSol: snapR.spotPriceSol,
      solUsd: 140,
      fallbackLiqLtv: Math.max(cf, 0.25),
    });
    lastRisk = {
      round,
      ltv: risk.ltv,
      toLiq: risk.toLiquidationPct,
      spot: snapR.spotPriceSol,
      debtUsd: risk.debtUsd,
      collUsd: risk.collateralUsd,
      liqLtv: risk.liquidationLtv,
    };
    console.log("risk", lastRisk);

    try {
      const r = await sendOmnipairLiquidateTx({
        connection,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        wallet: walletOf(liquidator) as any,
        snapshot: snapR,
        positionOwner: victim.publicKey,
        collateralMint: NATIVE_MINT,
      });
      liquidated = r.signature;
      console.log("LIQUIDATED", r.signature);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn("liquidate:", msg.slice(0, 160));
      if (!/0x178d|NotUndercollateralized/i.test(msg)) throw e;
    }
  }

  const proof = {
    ok: Boolean(liquidated),
    liquidated,
    lastRisk,
    victim: victim.publicKey.toBase58(),
    liquidator: liquidator.publicKey.toBase58(),
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
