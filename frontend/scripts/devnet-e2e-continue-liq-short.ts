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
import { NATIVE_MINT } from "@solana/spl-token";
import { fetchOmnipairPoolSnapshot } from "../src/lib/omnipairPoolState";
import { sendOmnipairSwapTx } from "../src/lib/omnipairSwap";
import {
  fetchOmnipairUserPosition,
  sendOmnipairLiquidateTx,
} from "../src/lib/omnipairLending";
import { riskFromOnChainPosition } from "../src/lib/positionMetrics";
import { poolSafeCf } from "../src/lib/poolMaxLeverage";

const ROOT = path.resolve(__dirname, "..");
const meta = JSON.parse(
  fs.readFileSync(path.join(ROOT, ".e2e-tmp/talesfun-test-mint.json"), "utf8")
);
const prev = JSON.parse(
  fs.readFileSync(
    path.join(ROOT, ".e2e-tmp/force-liquidate-short-proof.json"),
    "utf8"
  )
);
const OUT = path.join(ROOT, ".e2e-tmp/force-liquidate-short-proof.json");
const RPC = process.env.NEXT_PUBLIC_SOLANA_RPC_URL!;

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
  const victim = new PublicKey(prev.victim as string);
  const liquidator = Keypair.generate();

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

  const excBal = (await connection.getBalance(exc.publicKey)) / 1e9;
  console.log({ excBal, victim: victim.toBase58() });
  await fund(liquidator, 0.05);

  const buyAmt = Math.min(0.28, Math.max(0.05, excBal - 0.12));
  const snap0 = await fetchOmnipairPoolSnapshot(
    connection,
    meta.gammPool,
    meta.mint,
    exc.publicKey
  );
  if (!snap0.ok) throw new Error(snap0.message);
  const buy = await sendOmnipairSwapTx({
    connection,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    wallet: walletOf(exc) as any,
    snapshot: snap0.data,
    side: "buy",
    amountUi: buyAmt,
    slippagePercent: 40,
  });
  console.log("EXC pump", buy.signature.slice(0, 12), buyAmt);
  await new Promise(r => setTimeout(r, 1200));

  const snapR = await fetchOmnipairPoolSnapshot(
    connection,
    meta.gammPool,
    meta.mint,
    null
  );
  if (!snapR.ok) throw new Error(snapR.message);
  const view = await fetchOmnipairUserPosition({
    connection,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    wallet: walletOf(liquidator) as any,
    snapshot: snapR.data,
    owner: victim,
  });
  if (!view) throw new Error("position gone");
  const cf = poolSafeCf(Number(snapR.data.reserveSolRaw) / 1e9);
  const risk = riskFromOnChainPosition({
    pos: view,
    projectMint: snapR.data.projectMint,
    projectDecimals: snapR.data.projectTokenDecimals,
    spotSol: snapR.data.spotPriceSol,
    solUsd: 140,
    fallbackLiqLtv: Math.max(cf, 0.2),
  });
  console.log("risk", {
    ltv: risk.ltv,
    toLiq: risk.toLiquidationPct,
    liqLtv: risk.liquidationLtv,
    spot: snapR.data.spotPriceSol,
    debtUsd: risk.debtUsd,
    collUsd: risk.collateralUsd,
    lockedCf0: view.collateral0LiquidationCfBps,
    lockedCf1: view.collateral1LiquidationCfBps,
  });

  try {
    const r = await sendOmnipairLiquidateTx({
      connection,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      wallet: walletOf(liquidator) as any,
      snapshot: snapR.data,
      positionOwner: victim,
      collateralMint: NATIVE_MINT,
    });
    const proof = {
      ok: true,
      liquidated: r.signature,
      risk,
      victim: victim.toBase58(),
      at: new Date().toISOString(),
    };
    fs.writeFileSync(OUT, JSON.stringify(proof, null, 2));
    console.log("LIQUIDATED", r.signature);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    fs.writeFileSync(
      OUT,
      JSON.stringify(
        {
          ok: false,
          error: msg.slice(0, 400),
          risk,
          victim: victim.toBase58(),
          at: new Date().toISOString(),
        },
        null,
        2
      )
    );
    console.error("fail", msg.slice(0, 400));
    process.exit(1);
  }
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
