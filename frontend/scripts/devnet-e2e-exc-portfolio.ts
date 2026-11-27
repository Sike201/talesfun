/**
 * Real-scenario portfolio E2E:
 *  - Confirm LP burned / locked at incinerator
 *  - Concurrent traders: buys, sells, longs, shorts, borrows
 *  - EXC (phantom) wallet opens long + loan sequentially so Positions is visible on-chain
 *
 *   npx tsx --env-file=.env.local scripts/devnet-e2e-exc-portfolio.ts
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
import {
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { fetchOmnipairPoolSnapshot } from "../src/lib/omnipairPoolState";
import { sendOmnipairSwapTx } from "../src/lib/omnipairSwap";
import {
  deriveOmnipairUserPosition,
  fetchOmnipairUserPosition,
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
const OUT = path.join(ROOT, ".e2e-tmp/exc-portfolio-e2e.json");
const INCINERATOR = new PublicKey(
  "1nc1nerator11111111111111111111111111111111"
);

type Row = { role: string; ok: boolean; detail: string; ms: number };

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
  const exc = Keypair.fromSecretKey(Uint8Array.from(phantom));
  const connection = new Connection(RPC, "confirmed");

  const fund = async (kp: Keypair, sol: number) => {
    const lamports = Math.floor(sol * LAMPORTS_PER_SOL);
    if (lamports <= 0) return;
    const tx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: exc.publicKey,
        toPubkey: kp.publicKey,
        lamports,
      })
    );
    await sendAndConfirmTransaction(connection, tx, [exc], {
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
  const excBal = (await connection.getBalance(exc.publicKey)) / LAMPORTS_PER_SOL;

  // LP burn / lock check
  let lpBurned: Record<string, unknown> = {};
  try {
    const lpMint = snap0.data.lpMint;
    const info = await connection.getParsedAccountInfo(lpMint, "confirmed");
    const supply =
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (info.value?.data as any)?.parsed?.info?.supply ?? null;
    const incineratorAta = getAssociatedTokenAddressSync(
      lpMint,
      INCINERATOR,
      true,
      TOKEN_PROGRAM_ID
    );
    let incineratorLp = "0";
    try {
      const b = await connection.getTokenAccountBalance(incineratorAta);
      incineratorLp = b.value.amount;
    } catch {
      /* none */
    }
    lpBurned = {
      lpMint: lpMint.toBase58(),
      lpSupply: supply,
      incineratorLp,
      note:
        BigInt(incineratorLp) > BigInt(0) || supply === "0"
          ? "LP appears locked/burned (incinerator holds or supply zeroed)"
          : "LP may still be claimable — graduation lock should move srLP to incinerator",
    };
  } catch (e) {
    lpBurned = {
      error: e instanceof Error ? e.message : String(e),
    };
  }

  console.log(
    JSON.stringify(
      {
        mint,
        pool,
        reserveSol,
        cf: poolSafeCf(reserveSol),
        maxLev,
        spot: snap0.data.spotPriceSol,
        exc: exc.publicKey.toBase58(),
        excBal,
        lpBurned,
      },
      null,
      2
    )
  );

  if (excBal < 0.28) {
    throw new Error(
      `EXC wallet low on SOL (${excBal.toFixed(3)}). Fund ${exc.publicKey.toBase58()}`
    );
  }

  const rows: Row[] = [];
  const timed = async (role: string, fn: () => Promise<string>) => {
    const t0 = Date.now();
    try {
      const detail = await fn();
      rows.push({ role, ok: true, detail, ms: Date.now() - t0 });
      console.log(`[ok] ${role}`, detail);
    } catch (e) {
      const msg = (e instanceof Error ? e.message : String(e)).slice(0, 320);
      rows.push({ role, ok: false, detail: msg, ms: Date.now() - t0 });
      console.error(`[fail] ${role}`, msg);
    }
  };

  // ---- Concurrent swarm (8 fresh traders) ----
  const swarm = Array.from({ length: 8 }, () => Keypair.generate());
  // Keep ≥0.12 SOL on EXC for its own buy/long/sell + fees.
  const per = Math.min(0.045, Math.max(0.032, (excBal - 0.14) / swarm.length));
  for (let i = 0; i < swarm.length; i += 4) {
    await Promise.all(swarm.slice(i, i + 4).map(kp => fund(kp, per)));
  }

  const buyUi = Math.min(0.012, per * 0.28);
  const shortMargin = Math.min(0.006, per * 0.12);

  await Promise.all([
    timed("swarm-0-buy", async () => {
      const snap = await fetchOmnipairPoolSnapshot(
        connection,
        pool,
        mint,
        swarm[0]!.publicKey
      );
      if (!snap.ok) throw new Error(snap.message);
      const r = await sendOmnipairSwapTx({
        connection,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        wallet: walletOf(swarm[0]!) as any,
        snapshot: snap.data,
        side: "buy",
        amountUi: buyUi,
        slippagePercent: 20,
      });
      return r.signature.slice(0, 12);
    }),
    timed("swarm-1-buy", async () => {
      const snap = await fetchOmnipairPoolSnapshot(
        connection,
        pool,
        mint,
        swarm[1]!.publicKey
      );
      if (!snap.ok) throw new Error(snap.message);
      const r = await sendOmnipairSwapTx({
        connection,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        wallet: walletOf(swarm[1]!) as any,
        snapshot: snap.data,
        side: "buy",
        amountUi: buyUi,
        slippagePercent: 20,
      });
      return r.signature.slice(0, 12);
    }),
    timed("swarm-2-short", async () => {
      const snap = await fetchOmnipairPoolSnapshot(
        connection,
        pool,
        mint,
        swarm[2]!.publicKey
      );
      if (!snap.ok) throw new Error(snap.message);
      const res = await sendOmnipairLeverageStepTx({
        connection,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        wallet: walletOf(swarm[2]!) as any,
        snapshot: snap.data,
        direction: "short",
        marginUi: shortMargin,
        leverage: Math.min(maxLev, 1.25),
        slippagePercent: 25,
      });
      await upsertCanonicalTrade({
        mint,
        signature: res.sigs[res.sigs.length - 1]!,
        side: "short",
        sol_amount_raw: BigInt(Math.floor(shortMargin * 1e9)).toString(),
        token_amount_raw: "0",
        timestamp: new Date().toISOString(),
        wallet: swarm[2]!.publicKey.toBase58(),
        price_sol: snap.data.spotPriceSol,
        source: "omnipair",
      });
      return res.sigs.map(s => s.slice(0, 8)).join(",");
    }),
    timed("swarm-3-buy-long", async () => {
      const snap = await fetchOmnipairPoolSnapshot(
        connection,
        pool,
        mint,
        swarm[3]!.publicKey
      );
      if (!snap.ok) throw new Error(snap.message);
      const r = await sendOmnipairSwapTx({
        connection,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        wallet: walletOf(swarm[3]!) as any,
        snapshot: snap.data,
        side: "buy",
        amountUi: buyUi * 1.1,
        slippagePercent: 20,
      });
      return r.signature.slice(0, 12);
    }),
    timed("swarm-4-buy-borrow", async () => {
      const snap = await fetchOmnipairPoolSnapshot(
        connection,
        pool,
        mint,
        swarm[4]!.publicKey
      );
      if (!snap.ok) throw new Error(snap.message);
      const r = await sendOmnipairSwapTx({
        connection,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        wallet: walletOf(swarm[4]!) as any,
        snapshot: snap.data,
        side: "buy",
        amountUi: buyUi,
        slippagePercent: 20,
      });
      return r.signature.slice(0, 12);
    }),
    timed("swarm-5-buy", async () => {
      const snap = await fetchOmnipairPoolSnapshot(
        connection,
        pool,
        mint,
        swarm[5]!.publicKey
      );
      if (!snap.ok) throw new Error(snap.message);
      const r = await sendOmnipairSwapTx({
        connection,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        wallet: walletOf(swarm[5]!) as any,
        snapshot: snap.data,
        side: "buy",
        amountUi: buyUi * 0.9,
        slippagePercent: 20,
      });
      return r.signature.slice(0, 12);
    }),
    timed("swarm-6-short", async () => {
      const snap = await fetchOmnipairPoolSnapshot(
        connection,
        pool,
        mint,
        swarm[6]!.publicKey
      );
      if (!snap.ok) throw new Error(snap.message);
      const res = await sendOmnipairLeverageStepTx({
        connection,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        wallet: walletOf(swarm[6]!) as any,
        snapshot: snap.data,
        direction: "short",
        marginUi: shortMargin * 0.85,
        leverage: Math.min(maxLev, 1.2),
        slippagePercent: 25,
      });
      return res.sigs.map(s => s.slice(0, 8)).join(",");
    }),
    timed("swarm-7-buy", async () => {
      const snap = await fetchOmnipairPoolSnapshot(
        connection,
        pool,
        mint,
        swarm[7]!.publicKey
      );
      if (!snap.ok) throw new Error(snap.message);
      const r = await sendOmnipairSwapTx({
        connection,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        wallet: walletOf(swarm[7]!) as any,
        snapshot: snap.data,
        side: "buy",
        amountUi: buyUi,
        slippagePercent: 20,
      });
      return r.signature.slice(0, 12);
    }),
  ]);

  await new Promise(r => setTimeout(r, 1800));

  await Promise.all([
    timed("swarm-3-long", async () => {
      const tok = await tokBal(swarm[3]!.publicKey);
      const margin = Math.min(tok * 0.18, Math.max(25, tok * 0.08));
      if (!(margin > 0)) throw new Error(`no tokens (${tok})`);
      const snap = await fetchOmnipairPoolSnapshot(
        connection,
        pool,
        mint,
        swarm[3]!.publicKey
      );
      if (!snap.ok) throw new Error(snap.message);
      const res = await sendOmnipairLeverageStepTx({
        connection,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        wallet: walletOf(swarm[3]!) as any,
        snapshot: snap.data,
        direction: "long",
        marginUi: margin,
        leverage: Math.min(maxLev, 1.3),
        slippagePercent: 22,
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
        wallet: swarm[3]!.publicKey.toBase58(),
        price_sol: snap.data.spotPriceSol,
        source: "omnipair",
      });
      return res.sigs.map(s => s.slice(0, 8)).join(",");
    }),
    timed("swarm-4-borrow", async () => {
      const tok = await tokBal(swarm[4]!.publicKey);
      const coll = Math.min(tok * 0.2, 280);
      if (!(coll > 0)) throw new Error(`no tokens (${tok})`);
      const snap = await fetchOmnipairPoolSnapshot(
        connection,
        pool,
        mint,
        swarm[4]!.publicKey
      );
      if (!snap.ok) throw new Error(snap.message);
      const res = await sendOmnipairBorrowAgainstProjectTx({
        connection,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        wallet: walletOf(swarm[4]!) as any,
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
        wallet: swarm[4]!.publicKey.toBase58(),
        price_sol: snap.data.spotPriceSol,
        source: "omnipair",
      });
      return `${res.collateralSig.slice(0, 8)},${res.borrowSig.slice(0, 8)}`;
    }),
    timed("swarm-1-sell", async () => {
      const tok = await tokBal(swarm[1]!.publicKey);
      const sell = tok * 0.4;
      if (!(sell > 1)) throw new Error(`nothing to sell (${tok})`);
      const snap = await fetchOmnipairPoolSnapshot(
        connection,
        pool,
        mint,
        swarm[1]!.publicKey
      );
      if (!snap.ok) throw new Error(snap.message);
      const r = await sendOmnipairSwapTx({
        connection,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        wallet: walletOf(swarm[1]!) as any,
        snapshot: snap.data,
        side: "sell",
        amountUi: sell,
        slippagePercent: 28,
      });
      return r.signature.slice(0, 12);
    }),
    timed("swarm-5-sell", async () => {
      const tok = await tokBal(swarm[5]!.publicKey);
      const sell = tok * 0.35;
      if (!(sell > 1)) throw new Error(`nothing to sell (${tok})`);
      const snap = await fetchOmnipairPoolSnapshot(
        connection,
        pool,
        mint,
        swarm[5]!.publicKey
      );
      if (!snap.ok) throw new Error(snap.message);
      const r = await sendOmnipairSwapTx({
        connection,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        wallet: walletOf(swarm[5]!) as any,
        snapshot: snap.data,
        side: "sell",
        amountUi: sell,
        slippagePercent: 28,
      });
      return r.signature.slice(0, 12);
    }),
  ]);

  // ---- EXC wallet: buy → long (leave open) → also do a sell from leftover ----
  await timed("exc-buy", async () => {
    const snap = await fetchOmnipairPoolSnapshot(
      connection,
      pool,
      mint,
      exc.publicKey
    );
    if (!snap.ok) throw new Error(snap.message);
    const r = await sendOmnipairSwapTx({
      connection,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      wallet: walletOf(exc) as any,
      snapshot: snap.data,
      side: "buy",
      amountUi: 0.04,
      slippagePercent: 18,
    });
    await upsertCanonicalTrade({
      mint,
      signature: r.signature,
      side: "buy",
      sol_amount_raw: BigInt(Math.floor(0.04 * 1e9)).toString(),
      token_amount_raw: "0",
      timestamp: new Date().toISOString(),
      wallet: exc.publicKey.toBase58(),
      price_sol: snap.data.spotPriceSol,
      source: "omnipair",
    });
    return r.signature.slice(0, 12);
  });

  await new Promise(r => setTimeout(r, 1500));

  await timed("exc-long", async () => {
    const tok = await tokBal(exc.publicKey);
    const margin = Math.min(tok * 0.15, Math.max(40, tok * 0.08));
    if (!(margin > 0)) throw new Error(`EXC no tokens (${tok})`);
    const snap = await fetchOmnipairPoolSnapshot(
      connection,
      pool,
      mint,
      exc.publicKey
    );
    if (!snap.ok) throw new Error(snap.message);
    const res = await sendOmnipairLeverageStepTx({
      connection,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      wallet: walletOf(exc) as any,
      snapshot: snap.data,
      direction: "long",
      marginUi: margin,
      leverage: Math.min(maxLev, 1.35),
      slippagePercent: 20,
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
      wallet: exc.publicKey.toBase58(),
      price_sol: snap.data.spotPriceSol,
      source: "omnipair",
    });
    return res.sigs.map(s => s.slice(0, 8)).join(",");
  });

  // Second EXC path: if long left room, also try a small sell of leftover inventory
  await timed("exc-sell-leftover", async () => {
    const tok = await tokBal(exc.publicKey);
    const sell = tok * 0.08;
    if (!(sell > 1)) throw new Error(`no leftover (${tok})`);
    const snap = await fetchOmnipairPoolSnapshot(
      connection,
      pool,
      mint,
      exc.publicKey
    );
    if (!snap.ok) throw new Error(snap.message);
    const r = await sendOmnipairSwapTx({
      connection,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      wallet: walletOf(exc) as any,
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
      wallet: exc.publicKey.toBase58(),
      price_sol: snap.data.spotPriceSol,
      source: "omnipair",
    });
    return r.signature.slice(0, 12);
  });

  // Verify EXC on-chain position for Positions UI
  const snapExc = await fetchOmnipairPoolSnapshot(
    connection,
    pool,
    mint,
    exc.publicKey
  );
  let excPosition: Record<string, unknown> | null = null;
  if (snapExc.ok) {
    const pos = await fetchOmnipairUserPosition({
      connection,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      wallet: walletOf(exc) as any,
      snapshot: snapExc.data,
    });
    const [pda] = deriveOmnipairUserPosition(snapExc.data.pair, exc.publicKey);
    excPosition = pos
      ? {
          pda: pda.toBase58(),
          collateral0: pos.collateral0.toString(),
          collateral1: pos.collateral1.toString(),
          debt0: pos.debt0Raw.toString(),
          debt1: pos.debt1Raw.toString(),
          visibleInUi:
            "Connect EXC wallet on token page → Positions shows on-chain long/loan",
        }
      : { pda: pda.toBase58(), open: false };
  }

  const summary = {
    at: new Date().toISOString(),
    mint,
    pool,
    excWallet: exc.publicKey.toBase58(),
    lpBurned,
    excPosition,
    ok: rows.filter(r => r.ok).length,
    fail: rows.filter(r => !r.ok).length,
    failures: rows.filter(r => !r.ok),
    rows,
  };
  fs.writeFileSync(OUT, JSON.stringify(summary, null, 2));
  console.log(
    JSON.stringify(
      {
        at: summary.at,
        excWallet: summary.excWallet,
        ok: summary.ok,
        fail: summary.fail,
        lpBurned: summary.lpBurned,
        excPosition: summary.excPosition,
        failures: summary.failures,
      },
      null,
      2
    )
  );
  process.exit(summary.fail > 0 ? 1 : 0);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
