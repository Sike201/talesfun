/**
 * Simultaneous multi-trader stress on one token (~20 wallets by default).
 * Mix of buys/sells + long/short/borrow opens, then concurrent closes.
 *
 *   TRADERS=20 npx tsx --env-file=.env.local scripts/devnet-e2e-multi-stress-close.ts
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
const TRADERS_FILE = path.join(ROOT, ".e2e-tmp/multi-stress-20-traders.json");
const TARGET_TRADERS = Math.max(
  4,
  Math.min(40, Number(process.env.TRADERS || "20") || 20)
);

type Role = "buy" | "sell" | "long" | "short" | "borrow";
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

function assignRole(i: number): Role {
  // Spread load: ~30% buy, 15% sell, 20% long, 15% short, 20% borrow
  const r = i % 20;
  if (r < 6) return "buy";
  if (r < 9) return "sell";
  if (r < 13) return "long";
  if (r < 16) return "short";
  return "borrow";
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

  // Keep ~0.04 SOL on payer for close top-ups / fees.
  const budget = Math.max(0, payerBal - 0.04);
  const perTrader = Math.min(0.055, budget / TARGET_TRADERS);
  if (perTrader < 0.028) {
    throw new Error(
      `Need more SOL for ${TARGET_TRADERS} traders (have ${payerBal.toFixed(3)} SOL, ` +
        `perTrader=${perTrader.toFixed(4)}). Fund payer ${payer.publicKey.toBase58()}`
    );
  }

  const traders = Array.from({ length: TARGET_TRADERS }, (_, i) => ({
    kp: Keypair.generate(),
    role: assignRole(i),
    i,
  }));

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
        traders: TARGET_TRADERS,
        perTrader,
        roles: traders.reduce(
          (acc, t) => {
            acc[t.role] = (acc[t.role] || 0) + 1;
            return acc;
          },
          {} as Record<string, number>
        ),
      },
      null,
      2
    )
  );

  // Persist secrets so we can sweep later if needed.
  fs.writeFileSync(
    TRADERS_FILE,
    JSON.stringify(
      traders.map(t => ({
        i: t.i,
        role: t.role,
        pubkey: t.kp.publicKey.toBase58(),
        secret: Array.from(t.kp.secretKey),
      })),
      null,
      2
    )
  );

  // Fund in small batches to avoid RPC bursts / blockhash races.
  for (let i = 0; i < traders.length; i += 5) {
    const batch = traders.slice(i, i + 5);
    await Promise.all(batch.map(t => fund(t.kp, perTrader)));
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
      const msg = (e instanceof Error ? e.message : String(e)).slice(0, 320);
      rows.push({ role, ok: false, detail: msg, ms: Date.now() - t0 });
      console.error(`[fail] ${role}`, msg);
    }
  };

  const buyUi = Math.min(0.014, perTrader * 0.26);
  const shortMargin = Math.min(0.007, perTrader * 0.12);

  // ---------- Wave 1: everyone acts at once ----------
  await Promise.all(
    traders.map(t =>
      timed(`w1-${t.role}-${t.i}`, async () => {
        const snap = await fetchOmnipairPoolSnapshot(
          connection,
          pool,
          mint,
          t.kp.publicKey
        );
        if (!snap.ok) throw new Error(snap.message);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const wallet = walletOf(t.kp) as any;

        if (t.role === "buy" || t.role === "sell" || t.role === "long" || t.role === "borrow") {
          // sell/long/borrow need inventory first
          const r = await sendOmnipairSwapTx({
            connection,
            wallet,
            snapshot: snap.data,
            side: "buy",
            amountUi: t.role === "buy" ? buyUi : buyUi * 1.05,
            slippagePercent: 20,
          });
          if (t.role === "buy") {
            await upsertCanonicalTrade({
              mint,
              signature: r.signature,
              side: "buy",
              sol_amount_raw: BigInt(Math.floor(buyUi * 1e9)).toString(),
              token_amount_raw: "0",
              timestamp: new Date().toISOString(),
              wallet: t.kp.publicKey.toBase58(),
              price_sol: snap.data.spotPriceSol,
              source: "omnipair",
            });
            return [r.signature];
          }
          // stash buy sig; follow-up in wave 2 for sell/long/borrow
          (t as { buySig?: string }).buySig = r.signature;
          return [r.signature];
        }

        // short opens immediately (SOL collateral)
        const res = await sendOmnipairLeverageStepTx({
          connection,
          wallet,
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
          wallet: t.kp.publicKey.toBase58(),
          price_sol: snap.data.spotPriceSol,
          source: "omnipair",
        });
        (t as { opened?: boolean }).opened = true;
        return res.sigs;
      })
    )
  );

  await new Promise(r => setTimeout(r, 2000));

  // ---------- Wave 2: long / borrow / sell pressure (simultaneous) ----------
  await Promise.all(
    traders
      .filter(t => t.role === "long" || t.role === "borrow" || t.role === "sell")
      .map(t =>
        timed(`w2-${t.role}-${t.i}`, async () => {
          const snap = await fetchOmnipairPoolSnapshot(
            connection,
            pool,
            mint,
            t.kp.publicKey
          );
          if (!snap.ok) throw new Error(snap.message);
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const wallet = walletOf(t.kp) as any;
          const tok = await tokBal(t.kp.publicKey);

          if (t.role === "sell") {
            const sell = tok * 0.45;
            if (!(sell > 1)) throw new Error(`nothing to sell (${tok})`);
            const r = await sendOmnipairSwapTx({
              connection,
              wallet,
              snapshot: snap.data,
              side: "sell",
              amountUi: sell,
              slippagePercent: 28,
            });
            await upsertCanonicalTrade({
              mint,
              signature: r.signature,
              side: "sell",
              sol_amount_raw: "0",
              token_amount_raw: BigInt(Math.floor(sell * 1e6)).toString(),
              timestamp: new Date().toISOString(),
              wallet: t.kp.publicKey.toBase58(),
              price_sol: snap.data.spotPriceSol,
              source: "omnipair",
            });
            return [r.signature];
          }

          if (t.role === "long") {
            const margin = Math.min(tok * 0.18, Math.max(30, tok * 0.08));
            if (!(margin > 0)) throw new Error(`no tokens for long (${tok})`);
            const res = await sendOmnipairLeverageStepTx({
              connection,
              wallet,
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
              wallet: t.kp.publicKey.toBase58(),
              price_sol: snap.data.spotPriceSol,
              source: "omnipair",
            });
            (t as { opened?: boolean }).opened = true;
            return res.sigs;
          }

          // borrow
          const coll = Math.min(tok * 0.22, 350);
          if (!(coll > 0)) throw new Error(`no tokens for borrow (${tok})`);
          const res = await sendOmnipairBorrowAgainstProjectTx({
            connection,
            wallet,
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
            wallet: t.kp.publicKey.toBase58(),
            price_sol: snap.data.spotPriceSol,
            source: "omnipair",
          });
          (t as { opened?: boolean }).opened = true;
          return [res.collateralSig, res.borrowSig];
        })
      )
  );

  await new Promise(r => setTimeout(r, 2500));

  // ---------- Wave 3: close every opened leverage/borrow position at once ----------
  const toClose = traders.filter(
    t => t.role === "long" || t.role === "short" || t.role === "borrow"
  );
  const leftoverPayer =
    (await connection.getBalance(payer.publicKey)) / LAMPORTS_PER_SOL;
  const topUp = Math.min(
    0.012,
    Math.max(0, (leftoverPayer - 0.015) / Math.max(1, toClose.length))
  );

  await Promise.all(
    toClose.map(t =>
      timed(`w3-close-${t.role}-${t.i}`, async () => {
        if (topUp > 0.002) {
          try {
            await fund(t.kp, topUp);
          } catch {
            /* best-effort */
          }
        }
        const snap = await fetchOmnipairPoolSnapshot(
          connection,
          pool,
          mint,
          t.kp.publicKey
        );
        if (!snap.ok) throw new Error(snap.message);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const wallet = walletOf(t.kp) as any;
        const before = await fetchOmnipairUserPosition({
          connection,
          wallet,
          snapshot: snap.data,
        });
        if (!before) throw new Error("no on-chain position to close");
        const direction =
          t.role === "short" ? "short" : t.role === "borrow" ? "borrow" : "long";
        const res = await sendOmnipairClosePositionTx({
          connection,
          wallet,
          snapshot: snap.data,
          direction,
          slippagePercent: 28,
        });
        const after = await fetchOmnipairUserPosition({
          connection,
          wallet,
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
            `not fully closed d0=${after.debt0Raw} c0=${after.collateral0} c1=${after.collateral1}`
          );
        }
        return res.sigs;
      })
    )
  );

  // ---------- Wave 4: more concurrent buys/sells after closes ----------
  const buyers = traders.filter(t => t.role === "buy").slice(0, 4);
  const sellers = traders.filter(t => t.role === "sell").slice(0, 3);
  const dust =
    (await connection.getBalance(payer.publicKey)) / LAMPORTS_PER_SOL;
  if (dust > 0.06) {
    for (const t of buyers) {
      try {
        await fund(t.kp, 0.012);
      } catch {
        /* ignore */
      }
    }
  }

  await Promise.all([
    ...buyers.map(t =>
      timed(`w4-buy-${t.i}`, async () => {
        const snap = await fetchOmnipairPoolSnapshot(
          connection,
          pool,
          mint,
          t.kp.publicKey
        );
        if (!snap.ok) throw new Error(snap.message);
        const r = await sendOmnipairSwapTx({
          connection,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          wallet: walletOf(t.kp) as any,
          snapshot: snap.data,
          side: "buy",
          amountUi: Math.min(0.01, buyUi * 0.7),
          slippagePercent: 22,
        });
        return [r.signature];
      })
    ),
    ...sellers.map(t =>
      timed(`w4-sell-${t.i}`, async () => {
        const tok = await tokBal(t.kp.publicKey);
        const sell = tok * 0.3;
        if (!(sell > 1)) throw new Error(`nothing left to sell (${tok})`);
        const snap = await fetchOmnipairPoolSnapshot(
          connection,
          pool,
          mint,
          t.kp.publicKey
        );
        if (!snap.ok) throw new Error(snap.message);
        const r = await sendOmnipairSwapTx({
          connection,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          wallet: walletOf(t.kp) as any,
          snapshot: snap.data,
          side: "sell",
          amountUi: sell,
          slippagePercent: 28,
        });
        return [r.signature];
      })
    ),
  ]);

  const byRole = (prefix: string) =>
    rows.filter(r => r.role.startsWith(prefix));
  const summary = {
    at: new Date().toISOString(),
    mint,
    pool,
    traders: TARGET_TRADERS,
    ok: rows.filter(r => r.ok).length,
    fail: rows.filter(r => !r.ok).length,
    waves: {
      w1: {
        ok: byRole("w1-").filter(r => r.ok).length,
        fail: byRole("w1-").filter(r => !r.ok).length,
      },
      w2: {
        ok: byRole("w2-").filter(r => r.ok).length,
        fail: byRole("w2-").filter(r => !r.ok).length,
      },
      w3_close: {
        ok: byRole("w3-").filter(r => r.ok).length,
        fail: byRole("w3-").filter(r => !r.ok).length,
      },
      w4: {
        ok: byRole("w4-").filter(r => r.ok).length,
        fail: byRole("w4-").filter(r => !r.ok).length,
      },
    },
    failures: rows.filter(r => !r.ok).map(r => ({ role: r.role, detail: r.detail })),
    rows,
  };
  fs.writeFileSync(OUT, JSON.stringify(summary, null, 2));
  console.log(
    JSON.stringify(
      {
        at: summary.at,
        traders: summary.traders,
        ok: summary.ok,
        fail: summary.fail,
        waves: summary.waves,
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
