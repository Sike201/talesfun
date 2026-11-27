/**
 * Mainnet / hackathon readiness proof:
 *  1) Sweep dusty trader wallets → EXC
 *  2) Verify dedicated redirectable fee treasury + LP incinerator lock
 *  3) Concurrent swarm: buy/sell/long/short/borrow
 *  4) Force-undercollateralize victims → liquidate from separate wallets
 *  5) Write full proof JSON (fail hard if critical checks fail)
 *
 *   npx tsx --env-file=.env.local scripts/devnet-e2e-mainnet-readiness.ts
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
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { fetchOmnipairPoolSnapshot } from "../src/lib/omnipairPoolState";
import { sendOmnipairSwapTx } from "../src/lib/omnipairSwap";
import {
  deriveOmnipairUserPosition,
  fetchOmnipairUserPosition,
  sendOmnipairBorrowAgainstProjectTx,
  sendOmnipairClosePositionTx,
  sendOmnipairLeverageStepTx,
  sendOmnipairLiquidateTx,
} from "../src/lib/omnipairLending";
import { poolMaxLeverage, poolSafeCf } from "../src/lib/poolMaxLeverage";
import {
  platformFeeRecipient,
  platformFeeWalletIsExplicit,
  PLATFORM_FEE_BPS,
} from "../src/lib/platformFee";
import { riskFromOnChainPosition } from "../src/lib/positionMetrics";
import { upsertCanonicalTrade } from "../src/lib/persistCanonicalTrade";

const ROOT = path.resolve(__dirname, "..");
const meta = JSON.parse(
  fs.readFileSync(path.join(ROOT, ".e2e-tmp/talesfun-test-mint.json"), "utf8")
) as { mint: string; gammPool: string; ticker?: string };
const RPC =
  process.env.NEXT_PUBLIC_SOLANA_RPC_URL || "https://api.devnet.solana.com";
const mint = meta.mint;
const pool = meta.gammPool;
const OUT = path.join(ROOT, ".e2e-tmp/mainnet-readiness-proof.json");
const INCINERATOR = new PublicKey(
  "1nc1nerator11111111111111111111111111111111"
);
const RENT_FLOOR = 5_000_000; // leave ~0.005 SOL for ATA rent dust

type Check = {
  id: string;
  ok: boolean;
  detail: string;
  critical?: boolean;
  ms?: number;
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

function loadTraderSecrets(): Keypair[] {
  const files = [
    path.join(ROOT, ".e2e-tmp/multi-stress-20-traders.json"),
    path.join(ROOT, ".e2e-tmp/multi-traders.json"),
  ];
  const out: Keypair[] = [];
  const seen = new Set<string>();
  for (const f of files) {
    if (!fs.existsSync(f)) continue;
    try {
      const rows = JSON.parse(fs.readFileSync(f, "utf8")) as {
        secret?: number[];
      }[];
      for (const r of rows) {
        if (!r.secret?.length) continue;
        const kp = Keypair.fromSecretKey(Uint8Array.from(r.secret));
        const k = kp.publicKey.toBase58();
        if (seen.has(k)) continue;
        seen.add(k);
        out.push(kp);
      }
    } catch {
      /* ignore */
    }
  }
  return out;
}

async function main() {
  const checks: Check[] = [];
  const record = (c: Check) => {
    checks.push(c);
    console.log(
      `${c.ok ? "✓" : "✗"}${c.critical ? " [CRITICAL]" : ""} ${c.id}: ${c.detail}`
    );
  };
  const timed = async (
    id: string,
    fn: () => Promise<string>,
    critical = false
  ) => {
    const t0 = Date.now();
    try {
      const detail = await fn();
      record({ id, ok: true, detail, critical, ms: Date.now() - t0 });
    } catch (e) {
      record({
        id,
        ok: false,
        detail: (e instanceof Error ? e.message : String(e)).slice(0, 400),
        critical,
        ms: Date.now() - t0,
      });
      // Never abort mid-suite — collect all proof rows, fail at the end.
    }
  };

  const phantom = JSON.parse(
    fs.readFileSync(
      path.join(process.env.HOME!, ".config/solana/phantom.json"),
      "utf8"
    )
  ) as number[];
  const exc = Keypair.fromSecretKey(Uint8Array.from(phantom));
  const connection = new Connection(RPC, "confirmed");
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

  // ─── 0. Fee treasury / redirectability ─────────────────────────────
  const feePk = platformFeeRecipient();
  // Prefund rent-exempt SOL so tiny overlay transfers don't fail with
  // "account … insufficient funds for rent" on a brand-new treasury.
  if (feePk && !feePk.equals(exc.publicKey)) {
    const feeBal = await connection.getBalance(feePk);
    if (feeBal < 2_000_000) {
      const tx = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: exc.publicKey,
          toPubkey: feePk,
          lamports: 5_000_000,
        })
      );
      await sendAndConfirmTransaction(connection, tx, [exc], {
        commitment: "confirmed",
      });
      record({
        id: "fee-treasury-rent-prefund",
        ok: true,
        detail: `seeded 0.005 SOL rent buffer → ${feePk.toBase58()}`,
      });
    }
  }
  const feeBeforeNative = feePk ? await connection.getBalance(feePk) : 0;
  let feeBeforeWsol = BigInt(0);
  if (feePk) {
    try {
      const wsolAta = getAssociatedTokenAddressSync(
        NATIVE_MINT,
        feePk,
        false,
        TOKEN_PROGRAM_ID
      );
      feeBeforeWsol = BigInt(
        (await connection.getTokenAccountBalance(wsolAta)).value.amount
      );
    } catch {
      feeBeforeWsol = BigInt(0);
    }
  }
  record({
    id: "fee-wallet-configured",
    ok: feePk != null && platformFeeWalletIsExplicit(),
    critical: true,
    detail: feePk
      ? `treasury=${feePk.toBase58()} explicit=${platformFeeWalletIsExplicit()} bps=${PLATFORM_FEE_BPS} (redirect by changing NEXT_PUBLIC_PLATFORM_FEE_WALLET)`
      : "NEXT_PUBLIC_PLATFORM_FEE_WALLET unset — overlay fees disabled",
  });
  if (!feePk || feePk.equals(exc.publicKey)) {
    record({
      id: "fee-wallet-isolated",
      ok: false,
      critical: true,
      detail:
        "Fee wallet must be a dedicated treasury, not the EXC trading key",
    });
  } else {
    record({
      id: "fee-wallet-isolated",
      ok: true,
      detail: "Fee treasury ≠ EXC hot wallet",
    });
  }

  // ─── 1. Sweep dusty traders ────────────────────────────────────────
  const dusty = loadTraderSecrets();
  let sweptLamports = 0;
  let sweptWallets = 0;
  for (const kp of dusty) {
    try {
      // Best-effort: sell tokens then drain SOL
      const tokens = await tokBal(kp.publicKey);
      if (tokens > 10) {
        try {
          const snap = await snapFor(kp.publicKey);
          await sendOmnipairSwapTx({
            connection,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            wallet: walletOf(kp) as any,
            snapshot: snap,
            side: "sell",
            amountUi: tokens * 0.95,
            slippagePercent: 25,
          });
          await sleep(400);
        } catch {
          /* thin pool / no liquidity — skip */
        }
      }
      const bal = await connection.getBalance(kp.publicKey);
      const send = bal - RENT_FLOOR;
      if (send > 50_000) {
        const tx = new Transaction().add(
          SystemProgram.transfer({
            fromPubkey: kp.publicKey,
            toPubkey: exc.publicKey,
            lamports: send,
          })
        );
        await sendAndConfirmTransaction(connection, tx, [kp], {
          commitment: "confirmed",
        });
        sweptLamports += send;
        sweptWallets += 1;
      }
    } catch {
      /* continue */
    }
  }
  record({
    id: "sweep-dust",
    ok: true,
    detail: `swept ${sweptWallets}/${dusty.length} wallets → ${(sweptLamports / 1e9).toFixed(4)} SOL to EXC`,
  });

  const excBal = (await connection.getBalance(exc.publicKey)) / LAMPORTS_PER_SOL;
  record({
    id: "exc-funded",
    ok: excBal >= 2,
    critical: true,
    detail: `EXC ${exc.publicKey.toBase58()} has ${excBal.toFixed(4)} SOL`,
  });

  // ─── 2. LP incinerator proof ───────────────────────────────────────
  const snap0 = await snapFor();
  const lpMint = snap0.lpMint;
  const incineratorAta = getAssociatedTokenAddressSync(
    lpMint,
    INCINERATOR,
    true,
    TOKEN_PROGRAM_ID
  );
  let incineratorLp = "0";
  try {
    incineratorLp = (await connection.getTokenAccountBalance(incineratorAta))
      .value.amount;
  } catch {
    /* none */
  }
  const lpInfo = await connection.getParsedAccountInfo(lpMint, "confirmed");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const lpSupply = (lpInfo.value?.data as any)?.parsed?.info?.supply ?? null;
  const lpOk = BigInt(incineratorLp) > BigInt(0);
  record({
    id: "omlp-incinerator",
    ok: lpOk,
    critical: true,
    detail: `lpMint=${lpMint.toBase58()} supply=${lpSupply} incineratorLp=${incineratorLp} ${
      lpOk
        ? "LOCKED (cannot withdraw seeded LP)"
        : "MISSING — graduation should transfer claimable LP to incinerator"
    }`,
  });

  const reserveSol = Number(snap0.reserveSolRaw) / 1e9;
  const maxLev = poolMaxLeverage(reserveSol);
  console.log(
    JSON.stringify(
      {
        mint,
        pool,
        reserveSol,
        cf: poolSafeCf(reserveSol),
        maxLev,
        spot: snap0.spotPriceSol,
        feeTreasury: feePk?.toBase58(),
        excBal,
      },
      null,
      2
    )
  );

  // ─── 3. Concurrent swarm (swap / long / short / borrow) ────────────
  const N = 8;
  const swarm = Array.from({ length: N }, () => Keypair.generate());
  // Generous per-wallet SOL so fee skim + ATA + position rent never brick a leg.
  const per = Math.min(0.28, Math.max(0.18, (excBal - 2.5) / (N + 4)));
  for (let i = 0; i < swarm.length; i += 2) {
    await Promise.all(swarm.slice(i, i + 2).map(kp => fund(kp, per)));
  }
  await fund(swarm[3]!, 0.12);

  const buyUi = Math.min(0.035, per * 0.2);
  const shortMargin = Math.min(0.02, per * 0.08);

  // Stagger core paths — parallel only for chart noise later.
  await timed(
    "swarm-buy-a",
    async () => {
      const snap = await snapFor(swarm[0]!.publicKey);
      const r = await sendOmnipairSwapTx({
        connection,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        wallet: walletOf(swarm[0]!) as any,
        snapshot: snap,
        side: "buy",
        amountUi: buyUi,
        slippagePercent: 18,
      });
      await upsertCanonicalTrade({
        mint,
        signature: r.signature,
        side: "buy",
        sol_amount_raw: BigInt(Math.floor(buyUi * 1e9)).toString(),
        token_amount_raw: r.fill.token_amount_raw,
        timestamp: r.fill.timestamp,
        wallet: swarm[0]!.publicKey.toBase58(),
        price_sol: r.fill.price_sol,
        source: "omnipair",
      });
      return r.signature.slice(0, 12);
    },
    true
  );
  await timed("swarm-buy-b", async () => {
    const snap = await snapFor(swarm[1]!.publicKey);
    const r = await sendOmnipairSwapTx({
      connection,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      wallet: walletOf(swarm[1]!) as any,
      snapshot: snap,
      side: "buy",
      amountUi: buyUi,
      slippagePercent: 18,
    });
    return r.signature.slice(0, 12);
  });
  await timed("swarm-buy-c", async () => {
    const snap = await snapFor(swarm[2]!.publicKey);
    const r = await sendOmnipairSwapTx({
      connection,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      wallet: walletOf(swarm[2]!) as any,
      snapshot: snap,
      side: "buy",
      amountUi: buyUi * 0.9,
      slippagePercent: 18,
    });
    return r.signature.slice(0, 12);
  });
  await timed(
    "swarm-short",
    async () => {
      const snap = await snapFor(swarm[3]!.publicKey);
      const lev = poolMaxLeverage(Number(snap.reserveSolRaw) / 1e9);
      const r = await sendOmnipairLeverageStepTx({
        connection,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        wallet: walletOf(swarm[3]!) as any,
        snapshot: snap,
        direction: "short",
        marginUi: shortMargin,
        leverage: lev,
        slippagePercent: 20,
      });
      return r.sigs.map(s => s.slice(0, 8)).join(",");
    },
    true
  );

  // Sequential inventory-dependent paths after buys land
  await timed(
    "swarm-sell",
    async () => {
      await sleep(800);
      const tok = await tokBal(swarm[0]!.publicKey);
      if (!(tok > 0)) throw new Error("no tokens after buy");
      const snap = await snapFor(swarm[0]!.publicKey);
      const sellAmt = tok * 0.35;
      const r = await sendOmnipairSwapTx({
        connection,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        wallet: walletOf(swarm[0]!) as any,
        snapshot: snap,
        side: "sell",
        amountUi: sellAmt,
        slippagePercent: 20,
      });
      await upsertCanonicalTrade({
        mint,
        signature: r.signature,
        side: "sell",
        sol_amount_raw: r.fill.sol_amount_raw,
        token_amount_raw: r.fill.token_amount_raw,
        timestamp: r.fill.timestamp,
        wallet: swarm[0]!.publicKey.toBase58(),
        price_sol: r.fill.price_sol,
        source: "omnipair",
      });
      return `${r.signature.slice(0, 12)} sold=${sellAmt.toFixed(1)}`;
    },
    true
  );

  await timed(
    "swarm-long",
    async () => {
      const tok = await tokBal(swarm[1]!.publicKey);
      const margin = Math.min(tok * 0.2, Math.max(80, tok * 0.08));
      if (!(margin > 0)) throw new Error(`no margin tokens (${tok})`);
      const snap = await snapFor(swarm[1]!.publicKey);
      const lev = poolMaxLeverage(Number(snap.reserveSolRaw) / 1e9);
      const r = await sendOmnipairLeverageStepTx({
        connection,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        wallet: walletOf(swarm[1]!) as any,
        snapshot: snap,
        direction: "long",
        marginUi: margin,
        leverage: lev,
        slippagePercent: 18,
      });
      return `${r.sigs.map(s => s.slice(0, 8)).join(",")} ${lev.toFixed(1)}x`;
    },
    true
  );

  await timed(
    "swarm-borrow",
    async () => {
      const tok = await tokBal(swarm[2]!.publicKey);
      const coll = Math.min(tok * 0.25, 2000);
      if (!(coll > 0)) throw new Error(`no coll (${tok})`);
      const snap = await snapFor(swarm[2]!.publicKey);
      const r = await sendOmnipairBorrowAgainstProjectTx({
        connection,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        wallet: walletOf(swarm[2]!) as any,
        snapshot: snap,
        collateralTokenUi: coll,
      });
      return `${r.borrowSig.slice(0, 12)} coll=${coll.toFixed(1)}`;
    },
    true
  );

  // Parallel chart traffic (non-critical)
  await Promise.all(
    [4, 5, 6, 7].map(i =>
      timed(`swarm-chart-buy-${i}`, async () => {
        const snap = await snapFor(swarm[i]!.publicKey);
        const r = await sendOmnipairSwapTx({
          connection,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          wallet: walletOf(swarm[i]!) as any,
          snapshot: snap,
          side: "buy",
          amountUi: buyUi * 0.4,
          slippagePercent: 22,
        });
        return r.signature.slice(0, 12);
      })
    )
  );

  // ─── 4. Fee accrual proof (native buy skims + WSOL sell skims) ──────
  if (feePk) {
    const feeAfterNative = await connection.getBalance(feePk);
    let feeAfterWsol = BigInt(0);
    try {
      const wsolAta = getAssociatedTokenAddressSync(
        NATIVE_MINT,
        feePk,
        false,
        TOKEN_PROGRAM_ID
      );
      feeAfterWsol = BigInt(
        (await connection.getTokenAccountBalance(wsolAta)).value.amount
      );
    } catch {
      feeAfterWsol = BigInt(0);
    }
    const deltaNative = feeAfterNative - feeBeforeNative;
    const deltaWsol = feeAfterWsol - feeBeforeWsol;
    const deltaTotal = BigInt(deltaNative) + deltaWsol;
    record({
      id: "fee-accrual",
      ok: deltaTotal > BigInt(0),
      critical: true,
      detail: `nativeΔ=${(deltaNative / 1e9).toFixed(6)} SOL wsolΔ=${Number(deltaWsol) / 1e9} SOL total=${Number(deltaTotal) / 1e9}`,
    });
  }

  // ─── 5. Liquidation drill ──────────────────────────────────────────
  // Victim A: max LTV borrow, then dump market with whales to crash coll value.
  const victimBorrow = Keypair.generate();
  const victimShort = Keypair.generate();
  const liquidator = Keypair.generate();
  const whale = Keypair.generate();
  await fund(victimBorrow, 0.35);
  await fund(victimShort, 0.32);
  await fund(liquidator, 0.1);
  await fund(whale, Math.min(0.8, Math.max(0.4, excBal * 0.1)));

  await timed(
    "liq-victim-borrow-open",
    async () => {
      const snap = await snapFor(victimBorrow.publicKey);
      await sendOmnipairSwapTx({
        connection,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        wallet: walletOf(victimBorrow) as any,
        snapshot: snap,
        side: "buy",
        amountUi: 0.1,
        slippagePercent: 20,
      });
      await sleep(1000);
      const tok = await tokBal(victimBorrow.publicKey);
      const coll = tok * 0.92;
      const snap2 = await snapFor(victimBorrow.publicKey);
      const collValueSol = coll * snap2.spotPriceSol;
      const maxCf = poolSafeCf(Number(snap2.reserveSolRaw) / 1e9);
      // Push near pool borrow limit so a dump can undercollateralize.
      const borrowSolUi = collValueSol * Math.min(0.9, maxCf * 0.92);
      const r = await sendOmnipairBorrowAgainstProjectTx({
        connection,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        wallet: walletOf(victimBorrow) as any,
        snapshot: snap2,
        collateralTokenUi: coll,
        borrowSolUi,
      });
      return `borrow ${r.borrowSig.slice(0, 12)} coll=${coll.toFixed(1)} borrowSol=${borrowSolUi.toFixed(6)}`;
    },
    true
  );

  await timed(
    "liq-victim-short-open",
    async () => {
      const snap = await snapFor(victimShort.publicKey);
      const lev = poolMaxLeverage(Number(snap.reserveSolRaw) / 1e9);
      const r = await sendOmnipairLeverageStepTx({
        connection,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        wallet: walletOf(victimShort) as any,
        snapshot: snap,
        direction: "short",
        marginUi: 0.05,
        leverage: lev,
        slippagePercent: 22,
      });
      return r.sigs.map(s => s.slice(0, 8)).join(",");
    },
    true
  );

  // Crash price: whale sells massive inventory (buy then dump)
  await timed(
    "liq-crash-price",
    async () => {
      const snap = await snapFor(whale.publicKey);
      const buy = await sendOmnipairSwapTx({
        connection,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        wallet: walletOf(whale) as any,
        snapshot: snap,
        side: "buy",
        amountUi: Math.min(0.55, (await connection.getBalance(whale.publicKey)) / 1e9 * 0.55),
        slippagePercent: 35,
      });
      await sleep(1200);
      const tok = await tokBal(whale.publicKey);
      const snap2 = await snapFor(whale.publicKey);
      const sell = await sendOmnipairSwapTx({
        connection,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        wallet: walletOf(whale) as any,
        snapshot: snap2,
        side: "sell",
        amountUi: tok * 0.98,
        slippagePercent: 40,
      });
      return `buy=${buy.signature.slice(0, 8)} sell=${sell.signature.slice(0, 8)} tok=${tok.toFixed(0)}`;
    },
    true
  );

  // Pump against short: another buy wave from remaining swarm
  await timed("liq-pump-vs-short", async () => {
    const snaps = await Promise.all(
      [4, 5, 6].map(async i => {
        const snap = await snapFor(swarm[i]!.publicKey);
        return sendOmnipairSwapTx({
          connection,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          wallet: walletOf(swarm[i]!) as any,
          snapshot: snap,
          side: "buy",
          amountUi: buyUi * 0.55,
          slippagePercent: 25,
        });
      })
    );
    return snaps.map(s => s.signature.slice(0, 8)).join(",");
  });

  await sleep(1500);

  // Risk snapshot before liquidate
  const snapRisk = await snapFor();
  for (const [label, owner] of [
    ["borrow-victim", victimBorrow.publicKey],
    ["short-victim", victimShort.publicKey],
  ] as const) {
    const view = await fetchOmnipairUserPosition({
      connection,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      wallet: walletOf(liquidator) as any,
      snapshot: snapRisk,
      owner,
    });
    if (view) {
      const risk = riskFromOnChainPosition({
        pos: view,
        projectMint: snapRisk.projectMint,
        projectDecimals: snapRisk.projectTokenDecimals,
        spotSol: snapRisk.spotPriceSol,
        solUsd: 140,
      });
      record({
        id: `liq-risk-${label}`,
        ok: true,
        detail: `ltv=${(risk.ltv * 100).toFixed(1)}% toLiq=${risk.toLiquidationPct.toFixed(1)}% ${risk.riskLabel} debtUsd=${risk.debtUsd.toFixed(4)} collUsd=${risk.collateralUsd.toFixed(4)} pda=${deriveOmnipairUserPosition(snapRisk.pair, owner)[0].toBase58().slice(0, 8)}`,
      });
    } else {
      record({
        id: `liq-risk-${label}`,
        ok: false,
        detail: "position missing on-chain",
      });
    }
  }

  const tryLiquidate = async (
    id: string,
    owner: PublicKey,
    collateralMint: PublicKey,
    dump: "sell" | "buy"
  ) => {
    const t0 = Date.now();
    let lastErr = "";
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        // Extra market move to push victim past liq threshold.
        if (attempt > 0) {
          const mover = swarm[Math.min(N - 1, 4 + attempt)]!;
          const snapM = await snapFor(mover.publicKey);
          if (dump === "sell") {
            let tok = await tokBal(mover.publicKey);
            if (tok < 50) {
              await sendOmnipairSwapTx({
                connection,
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                wallet: walletOf(mover) as any,
                snapshot: snapM,
                side: "buy",
                amountUi: buyUi * 0.8,
                slippagePercent: 30,
              });
              await sleep(800);
              tok = await tokBal(mover.publicKey);
            }
            if (tok > 0) {
              const snap2 = await snapFor(mover.publicKey);
              await sendOmnipairSwapTx({
                connection,
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                wallet: walletOf(mover) as any,
                snapshot: snap2,
                side: "sell",
                amountUi: tok * 0.95,
                slippagePercent: 40,
              });
            }
          } else {
            await sendOmnipairSwapTx({
              connection,
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              wallet: walletOf(mover) as any,
              snapshot: snapM,
              side: "buy",
              amountUi: buyUi * 0.9,
              slippagePercent: 30,
            });
          }
          await sleep(1000);
        }

        const snap = await snapFor(liquidator.publicKey);
        const r = await sendOmnipairLiquidateTx({
          connection,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          wallet: walletOf(liquidator) as any,
          snapshot: snap,
          positionOwner: owner,
          collateralMint,
        });
        record({
          id,
          ok: true,
          critical: true,
          detail: `${r.signature.slice(0, 16)} attempt=${attempt + 1}`,
          ms: Date.now() - t0,
        });
        return;
      } catch (e) {
        lastErr = (e instanceof Error ? e.message : String(e)).slice(0, 280);
        console.warn(`[liq retry ${attempt + 1}] ${id}: ${lastErr}`);
      }
    }
    record({
      id,
      ok: false,
      critical: true,
      detail: lastErr || "liquidate failed",
      ms: Date.now() - t0,
    });
  };

  await tryLiquidate(
    "liquidate-borrow-victim",
    victimBorrow.publicKey,
    (await snapFor()).projectMint,
    "sell"
  );
  await tryLiquidate(
    "liquidate-short-victim",
    victimShort.publicKey,
    NATIVE_MINT,
    "buy"
  );

  // ─── 6. Close remaining healthy positions ──────────────────────────
  await timed("close-swarm-long", async () => {
    const snap = await snapFor(swarm[1]!.publicKey);
    const r = await sendOmnipairClosePositionTx({
      connection,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      wallet: walletOf(swarm[1]!) as any,
      snapshot: snap,
      direction: "long",
    });
    return r.sigs.map(s => s.slice(0, 8)).join(",");
  });

  await timed("close-swarm-short", async () => {
    const snap = await snapFor(swarm[3]!.publicKey);
    const r = await sendOmnipairClosePositionTx({
      connection,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      wallet: walletOf(swarm[3]!) as any,
      snapshot: snap,
      direction: "short",
    });
    return r.sigs.map(s => s.slice(0, 8)).join(",");
  });

  await timed("close-swarm-borrow", async () => {
    const snap = await snapFor(swarm[2]!.publicKey);
    const r = await sendOmnipairClosePositionTx({
      connection,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      wallet: walletOf(swarm[2]!) as any,
      snapshot: snap,
      direction: "borrow",
    });
    return r.sigs.map(s => s.slice(0, 8)).join(",");
  });

  // Persist swarm keys for later sweep
  fs.writeFileSync(
    path.join(ROOT, ".e2e-tmp/mainnet-readiness-traders.json"),
    JSON.stringify(
      swarm.map((kp, i) => ({
        i,
        pubkey: kp.publicKey.toBase58(),
        secret: Array.from(kp.secretKey),
      })),
      null,
      2
    )
  );

  const criticalFails = checks.filter(c => c.critical && !c.ok);
  const proof = {
    ok: criticalFails.length === 0,
    at: new Date().toISOString(),
    mint,
    pool,
    feeTreasury: feePk?.toBase58() ?? null,
    incineratorLp,
    checks,
    criticalFails: criticalFails.map(c => c.id),
  };
  fs.writeFileSync(OUT, JSON.stringify(proof, null, 2));
  console.log("\n=== PROOF SUMMARY ===");
  console.log(JSON.stringify(proof, null, 2));
  process.exit(proof.ok ? 0 : 1);
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
