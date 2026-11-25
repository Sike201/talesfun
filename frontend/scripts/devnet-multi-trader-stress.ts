/**
 * Multi-trader E2E stress: ~20 wallets buy/sell across graduated Omnipair pools,
 * with periodic leverage + borrow smokes. Drives landing-page rank movement.
 *
 * Usage (from frontend/):
 *   npx tsx --env-file=.env.local scripts/devnet-multi-trader-stress.ts
 *
 * Env:
 *   TRADER_COUNT=20
 *   STRESS_MINUTES=90
 *   CONCURRENCY=5
 *   FUND_SOL=0.045
 *   SKIP_FUND=0
 *   SKIP_LEVERAGE=0
 *   SKIP_BORROW=0
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
import {
  getReadOnlyProgram,
  getTokenStatePDA,
  tokenStateToToken,
} from "../src/lib/program";
import { fetchOmnipairPoolSnapshot } from "../src/lib/omnipairPoolState";
import { sendOmnipairSwapTx } from "../src/lib/omnipairSwap";
import {
  sendOmnipairBorrowAgainstProjectTx,
  sendOmnipairLeverageStepTx,
} from "../src/lib/omnipairLending";
import { upsertCanonicalTrade } from "../src/lib/persistCanonicalTrade";

const ROOT = path.resolve(__dirname, "..");
const TMP = path.join(ROOT, ".e2e-tmp");
const TRADERS_FILE = path.join(TMP, "multi-traders.json");
const STATS_FILE = path.join(TMP, "multi-stress-stats.json");
const LOG_FILE = path.join(TMP, "multi-stress.log");

const RPC =
  process.env.NEXT_PUBLIC_SOLANA_RPC_URL || "https://api.devnet.solana.com";
const TRADER_COUNT = Math.max(4, Math.min(40, Number(process.env.TRADER_COUNT || "20")));
const STRESS_MINUTES = Math.max(5, Number(process.env.STRESS_MINUTES || "90"));
const CONCURRENCY = Math.max(1, Math.min(12, Number(process.env.CONCURRENCY || "5")));
const FUND_SOL = Math.max(0.02, Number(process.env.FUND_SOL || "0.045"));
const SKIP_FUND = process.env.SKIP_FUND === "1";
const SKIP_LEVERAGE = process.env.SKIP_LEVERAGE === "1";
const SKIP_BORROW = process.env.SKIP_BORROW === "1";

type TraderRec = { secret: number[]; pubkey: string };
type PoolTarget = { mint: string; symbol: string; gammPool: string };

type Stats = {
  startedAt: string;
  buys: number;
  sells: number;
  leverageOk: number;
  leverageFail: number;
  borrowOk: number;
  borrowFail: number;
  fails: number;
  byMint: Record<string, { buys: number; sells: number; fails: number }>;
  lastErrors: string[];
};

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function log(...args: unknown[]) {
  const line = `[${new Date().toISOString().slice(11, 19)}] ${args
    .map((a) => (typeof a === "string" ? a : JSON.stringify(a)))
    .join(" ")}`;
  console.log(line);
  try {
    fs.mkdirSync(TMP, { recursive: true });
    fs.appendFileSync(LOG_FILE, line + "\n");
  } catch {
    /* ignore */
  }
}

function isTransientRpcError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return /blockhash not found|block height exceeded|timed out|429|fetch failed|ECONNRESET|socket hang up|node is behind|Too many requests|Transaction was not confirmed|simulation failed/i.test(
    msg
  );
}

async function withRpcRetry<T>(
  label: string,
  fn: () => Promise<T>,
  attempts = 4
): Promise<T> {
  let last: unknown;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      if (!isTransientRpcError(e) || i === attempts) throw e;
      const wait = 700 * i + Math.floor(Math.random() * 900);
      log(`${label} retry ${i}/${attempts}`, wait + "ms");
      await sleep(wait);
    }
  }
  throw last;
}

function loadPayer(): Keypair {
  return Keypair.fromSecretKey(
    Uint8Array.from(
      JSON.parse(
        fs.readFileSync(
          path.join(process.env.HOME!, ".config/solana/id.json"),
          "utf8"
        )
      )
    )
  );
}

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

function loadOrCreateTraders(): Keypair[] {
  fs.mkdirSync(TMP, { recursive: true });
  if (fs.existsSync(TRADERS_FILE)) {
    const raw = JSON.parse(fs.readFileSync(TRADERS_FILE, "utf8")) as TraderRec[];
    const kps = raw.slice(0, TRADER_COUNT).map((r) =>
      Keypair.fromSecretKey(Uint8Array.from(r.secret))
    );
    while (kps.length < TRADER_COUNT) {
      const kp = Keypair.generate();
      kps.push(kp);
    }
    persistTraders(kps);
    return kps;
  }
  const kps = Array.from({ length: TRADER_COUNT }, () => Keypair.generate());
  persistTraders(kps);
  return kps;
}

function persistTraders(kps: Keypair[]) {
  const recs: TraderRec[] = kps.map((kp) => ({
    secret: Array.from(kp.secretKey),
    pubkey: kp.publicKey.toBase58(),
  }));
  fs.writeFileSync(TRADERS_FILE, JSON.stringify(recs, null, 2));
}

function saveStats(stats: Stats) {
  fs.writeFileSync(STATS_FILE, JSON.stringify(stats, null, 2));
}

async function fundTraders(
  connection: Connection,
  payer: Keypair,
  traders: Keypair[]
) {
  const want = Math.floor(FUND_SOL * LAMPORTS_PER_SOL);
  const payerBal = await connection.getBalance(payer.publicKey);
  const need = want * traders.length + Math.floor(0.05 * LAMPORTS_PER_SOL);
  log("fund check", {
    payerSol: payerBal / LAMPORTS_PER_SOL,
    traders: traders.length,
    each: FUND_SOL,
    needSol: need / LAMPORTS_PER_SOL,
  });
  if (payerBal < need) {
    log("WARN low payer balance — funding what we can");
  }

  for (let i = 0; i < traders.length; i++) {
    const t = traders[i]!;
    const bal = await connection.getBalance(t.publicKey);
    if (bal >= want * 0.85) {
      log(`trader#${i} already funded`, (bal / LAMPORTS_PER_SOL).toFixed(4));
      continue;
    }
    const topUp = want - bal;
    if (topUp <= 0) continue;
    const left = await connection.getBalance(payer.publicKey);
    if (left < topUp + 5_000_000) {
      log(`stop funding at trader#${i} — payer low`);
      break;
    }
    const tx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: payer.publicKey,
        toPubkey: t.publicKey,
        lamports: topUp,
      })
    );
    const sig = await withRpcRetry(`fund#${i}`, () =>
      sendAndConfirmTransaction(connection, tx, [payer], {
        commitment: "confirmed",
        maxRetries: 3,
      })
    );
    log(`funded trader#${i}`, t.publicKey.toBase58().slice(0, 8), (topUp / 1e9).toFixed(4), sig.slice(0, 10));
    await sleep(250 + Math.floor(Math.random() * 200));
  }
}

async function loadPoolTargets(connection: Connection): Promise<PoolTarget[]> {
  const targets: PoolTarget[] = [];
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const key =
    process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() ||
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim();
  if (url && key) {
    try {
      const res = await fetch(
        `${url}/rest/v1/tokens?select=mint,symbol,gamm_pool,phase&phase=eq.graduated&gamm_pool=not.is.null&order=updated_at.desc&limit=24`,
        { headers: { apikey: key, Authorization: `Bearer ${key}` } }
      );
      const rows = (await res.json()) as Array<{
        mint: string;
        symbol: string;
        gamm_pool: string | null;
      }>;
      if (Array.isArray(rows)) {
        for (const r of rows) {
          if (r.mint && r.gamm_pool) {
            targets.push({
              mint: r.mint,
              symbol: r.symbol || r.mint.slice(0, 6),
              gammPool: r.gamm_pool,
            });
          }
        }
      }
    } catch (e) {
      log("supabase token list fail", e instanceof Error ? e.message : e);
    }
  }

  // Always include talesfun test if present
  const talesPath = path.join(TMP, "talesfun-test-mint.json");
  if (fs.existsSync(talesPath)) {
    const t = JSON.parse(fs.readFileSync(talesPath, "utf8")) as {
      mint: string;
      ticker?: string;
      gammPool?: string;
    };
    if (t.mint && t.gammPool && !targets.some((x) => x.mint === t.mint)) {
      targets.unshift({
        mint: t.mint,
        symbol: t.ticker || "TALESFUN",
        gammPool: t.gammPool,
      });
    }
  }

  // Verify pools still look graduated on-chain
  const program = getReadOnlyProgram(connection);
  const verified: PoolTarget[] = [];
  for (const t of targets) {
    try {
      const mint = new PublicKey(t.mint);
      const [pda] = getTokenStatePDA(mint);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const state = await (program.account as any).tokenState.fetch(pda);
      const token = tokenStateToToken(state, t.mint);
      if (token.gammPool) {
        verified.push({
          mint: t.mint,
          symbol: token.ticker || t.symbol,
          gammPool: token.gammPool,
        });
      }
    } catch {
      /* skip stale */
    }
  }
  return verified;
}

async function tokenUiBalance(
  connection: Connection,
  mint: PublicKey,
  owner: PublicKey
): Promise<number> {
  try {
    const ata = getAssociatedTokenAddressSync(mint, owner);
    const bal = await connection.getTokenAccountBalance(ata, "confirmed");
    return Number(bal.value.uiAmountString || "0");
  } catch {
    return 0;
  }
}

function bumpMint(
  stats: Stats,
  mint: string,
  field: "buys" | "sells" | "fails"
) {
  if (!stats.byMint[mint]) stats.byMint[mint] = { buys: 0, sells: 0, fails: 0 };
  stats.byMint[mint]![field] += 1;
}

function pushErr(stats: Stats, msg: string) {
  stats.lastErrors.push(msg.slice(0, 240));
  if (stats.lastErrors.length > 40) stats.lastErrors.shift();
}

async function doSwapRound(
  connection: Connection,
  trader: Keypair,
  traderIdx: number,
  target: PoolTarget,
  stats: Stats
) {
  const mint = new PublicKey(target.mint);
  const wallet = walletOf(trader);
  const balSol = (await connection.getBalance(trader.publicKey)) / 1e9;
  if (balSol < 0.012) {
    log(`t#${traderIdx} skip low SOL`, balSol.toFixed(4), target.symbol);
    return;
  }

  const snap = await fetchOmnipairPoolSnapshot(
    connection,
    target.gammPool,
    target.mint,
    trader.publicKey
  );
  if (!snap.ok) throw new Error(`snap: ${snap.message}`);

  // Skip pathologically thin / broken pools (simulation 0x1 / dust reserves).
  const reserveSol = Number(snap.data.reserveSolRaw) / 1e9;
  if (Number.isFinite(reserveSol) && reserveSol > 0 && reserveSol < 0.05) {
    log(`t#${traderIdx} skip thin pool`, target.symbol, reserveSol.toFixed(4));
    return;
  }

  const wantSellFirst = Math.random() < 0.35;
  const tokBal = await tokenUiBalance(connection, mint, trader.publicKey);

  if (wantSellFirst && tokBal > 40) {
    const sellUi = Math.min(tokBal * (0.15 + Math.random() * 0.4), tokBal * 0.6);
    const sell = await withRpcRetry(`t#${traderIdx} sell ${target.symbol}`, () =>
      sendOmnipairSwapTx({
        connection,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        wallet: wallet as any,
        snapshot: snap.data,
        side: "sell",
        amountUi: sellUi,
        slippagePercent: 14,
      })
    );
    await upsertCanonicalTrade({
      mint: target.mint,
      signature: sell.signature,
      side: "sell",
      sol_amount_raw: sell.fill.sol_amount_raw,
      token_amount_raw: sell.fill.token_amount_raw,
      timestamp: sell.fill.timestamp,
      wallet: trader.publicKey.toBase58(),
      price_sol: sell.fill.price_sol,
      source: "omnipair",
    });
    stats.sells += 1;
    bumpMint(stats, target.mint, "sells");
    log(
      `t#${traderIdx} SELL`,
      target.symbol,
      sellUi.toFixed(1),
      sell.signature.slice(0, 10)
    );
    await sleep(800 + Math.floor(Math.random() * 1200));
  }

  // Buy most of the time (drives MC / ranking churn)
  if (Math.random() < 0.78 && balSol > 0.015) {
    const whale = Math.random() < 0.08;
    const buySol = Math.min(
      balSol - 0.008,
      whale ? 0.02 + Math.random() * 0.015 : 0.004 + Math.random() * 0.01
    );
    if (buySol < 0.003) return;

    const snap2 = await fetchOmnipairPoolSnapshot(
      connection,
      target.gammPool,
      target.mint,
      trader.publicKey
    );
    if (!snap2.ok) throw new Error(`snap2: ${snap2.message}`);

    const buy = await withRpcRetry(`t#${traderIdx} buy ${target.symbol}`, () =>
      sendOmnipairSwapTx({
        connection,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        wallet: wallet as any,
        snapshot: snap2.data,
        side: "buy",
        amountUi: buySol,
        slippagePercent: 14,
      })
    );
    await upsertCanonicalTrade({
      mint: target.mint,
      signature: buy.signature,
      side: "buy",
      sol_amount_raw: buy.fill.sol_amount_raw,
      token_amount_raw: buy.fill.token_amount_raw,
      timestamp: buy.fill.timestamp,
      wallet: trader.publicKey.toBase58(),
      price_sol: buy.fill.price_sol,
      source: "omnipair",
    });
    stats.buys += 1;
    bumpMint(stats, target.mint, "buys");
    log(
      `t#${traderIdx} BUY`,
      target.symbol,
      buySol.toFixed(4),
      buy.signature.slice(0, 10)
    );
  }

  // Follow-up sell to recycle inventory / move ranks both ways
  if (Math.random() < 0.55) {
    await sleep(600 + Math.floor(Math.random() * 900));
    const ui = await tokenUiBalance(connection, mint, trader.publicKey);
    if (ui > 30) {
      const sellUi = Math.min(ui * (0.2 + Math.random() * 0.35), ui * 0.5);
      const snap3 = await fetchOmnipairPoolSnapshot(
        connection,
        target.gammPool,
        target.mint,
        trader.publicKey
      );
      if (snap3.ok) {
        const sell = await withRpcRetry(
          `t#${traderIdx} sell2 ${target.symbol}`,
          () =>
            sendOmnipairSwapTx({
              connection,
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              wallet: wallet as any,
              snapshot: snap3.data,
              side: "sell",
              amountUi: sellUi,
              slippagePercent: 14,
            })
        );
        await upsertCanonicalTrade({
          mint: target.mint,
          signature: sell.signature,
          side: "sell",
          sol_amount_raw: sell.fill.sol_amount_raw,
          token_amount_raw: sell.fill.token_amount_raw,
          timestamp: sell.fill.timestamp,
          wallet: trader.publicKey.toBase58(),
          price_sol: sell.fill.price_sol,
          source: "omnipair",
        });
        stats.sells += 1;
        bumpMint(stats, target.mint, "sells");
        log(
          `t#${traderIdx} SELL2`,
          target.symbol,
          sellUi.toFixed(1),
          sell.signature.slice(0, 10)
        );
      }
    }
  }
}

async function doLeverageSmoke(
  connection: Connection,
  kp: Keypair,
  target: PoolTarget,
  stats: Stats
) {
  const wallet = walletOf(kp);
  const snap = await fetchOmnipairPoolSnapshot(
    connection,
    target.gammPool,
    target.mint,
    kp.publicKey
  );
  if (!snap.ok) throw new Error(snap.message);
  const direction = Math.random() < 0.5 ? "short" : "long";
  const mint = new PublicKey(target.mint);
  const tok = await tokenUiBalance(connection, mint, kp.publicKey);
  const marginUi =
    direction === "short"
      ? 0.012 + Math.random() * 0.01
      : Math.min(Math.max(tok * 0.05, 200), tok * 0.2);
  if (direction === "long" && tok < 100) {
    log("leverage skip — need project tokens for long");
    return;
  }
  const res = await sendOmnipairLeverageStepTx({
    connection,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    wallet: wallet as any,
    snapshot: snap.data,
    direction,
    marginUi,
    leverage: 2,
    slippagePercent: 10,
  });
  stats.leverageOk += 1;
  log("LEVERAGE OK", target.symbol, direction, res.sigs?.[0]?.slice(0, 10));
}

async function doBorrowSmoke(
  connection: Connection,
  kp: Keypair,
  target: PoolTarget,
  stats: Stats
) {
  const mint = new PublicKey(target.mint);
  const ui = await tokenUiBalance(connection, mint, kp.publicKey);
  if (!(ui > 50)) {
    log("borrow skip — need tokens", target.symbol, ui);
    return;
  }
  const wallet = walletOf(kp);
  const snap = await fetchOmnipairPoolSnapshot(
    connection,
    target.gammPool,
    target.mint,
    kp.publicKey
  );
  if (!snap.ok) throw new Error(snap.message);
  const coll = Math.min(ui * 0.04, ui);
  const res = await sendOmnipairBorrowAgainstProjectTx({
    connection,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    wallet: wallet as any,
    snapshot: snap.data,
    collateralTokenUi: coll,
  });
  stats.borrowOk += 1;
  log("BORROW OK", target.symbol, res.borrowSig?.slice(0, 10));
}

async function runPool(workers: Promise<void>[], limit: number, task: () => Promise<void>) {
  while (workers.length >= limit) {
    await Promise.race(workers);
  }
  const p = task().finally(() => {
    const i = workers.indexOf(p);
    if (i >= 0) workers.splice(i, 1);
  });
  workers.push(p);
}

async function main() {
  fs.mkdirSync(TMP, { recursive: true });
  const connection = new Connection(RPC, {
    commitment: "confirmed",
    confirmTransactionInitialTimeout: 60_000,
  });
  const payer = loadPayer();
  const traders = loadOrCreateTraders();
  const stats: Stats = {
    startedAt: new Date().toISOString(),
    buys: 0,
    sells: 0,
    leverageOk: 0,
    leverageFail: 0,
    borrowOk: 0,
    borrowFail: 0,
    fails: 0,
    byMint: {},
    lastErrors: [],
  };

  log("multi-trader stress start", {
    traders: traders.length,
    minutes: STRESS_MINUTES,
    concurrency: CONCURRENCY,
    payer: payer.publicKey.toBase58(),
  });

  if (!SKIP_FUND) {
    await fundTraders(connection, payer, traders);
  }

  let targets = await loadPoolTargets(connection);
  if (targets.length === 0) {
    throw new Error("No graduated Omnipair pools found to stress");
  }
  log(
    "targets",
    targets.map((t) => `${t.symbol}:${t.mint.slice(0, 6)}`).join(", ")
  );

  const deadline = Date.now() + STRESS_MINUTES * 60_000;
  const workers: Promise<void>[] = [];
  let round = 0;
  let lastSpecial = 0;

  while (Date.now() < deadline) {
    round += 1;
    // Refresh target list periodically
    if (round % 40 === 0) {
      try {
        const refreshed = await loadPoolTargets(connection);
        if (refreshed.length) targets = refreshed;
      } catch {
        /* keep old */
      }
    }

    const traderIdx = Math.floor(Math.random() * traders.length);
    const trader = traders[traderIdx]!;
    const target = targets[Math.floor(Math.random() * targets.length)]!;

    await runPool(workers, CONCURRENCY, async () => {
      try {
        await doSwapRound(connection, trader, traderIdx, target, stats);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        // Soft-skip common transient / inventory errors so stress keeps moving.
        if (
          /custom program error: 0x1|insufficient|Attempt to debit|Simulation failed/i.test(
            msg
          )
        ) {
          log(`t#${traderIdx} soft-skip`, target.symbol, msg.slice(0, 100));
        } else {
          stats.fails += 1;
          bumpMint(stats, target.mint, "fails");
          pushErr(stats, `${target.symbol}: ${msg}`);
          log(`t#${traderIdx} FAIL`, target.symbol, msg.slice(0, 160));
        }
      }
      saveStats(stats);
    });

    // Periodic leverage / borrow from a funded trader that holds inventory
    if (
      Date.now() - lastSpecial > 90_000 &&
      (!SKIP_LEVERAGE || !SKIP_BORROW)
    ) {
      lastSpecial = Date.now();
      const specialTarget = targets[Math.floor(Math.random() * targets.length)]!;
      // Prefer payer for leverage/borrow — more likely to hold tokens
      const actor = Math.random() < 0.7 ? payer : traders[Math.floor(Math.random() * traders.length)]!;
      await runPool(workers, CONCURRENCY, async () => {
        if (!SKIP_LEVERAGE) {
          try {
            await doLeverageSmoke(connection, actor, specialTarget, stats);
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            if (/custom program error: 0x1|insufficient|Simulation failed/i.test(msg)) {
              log("LEVERAGE soft-skip", specialTarget.symbol, msg.slice(0, 100));
            } else {
              stats.leverageFail += 1;
              pushErr(stats, `lev ${specialTarget.symbol}: ${msg}`);
              log("LEVERAGE FAIL", specialTarget.symbol, msg.slice(0, 160));
            }
          }
        }
        if (!SKIP_BORROW) {
          try {
            await doBorrowSmoke(connection, actor, specialTarget, stats);
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            if (/custom program error: 0x1|insufficient|Simulation failed/i.test(msg)) {
              log("BORROW soft-skip", specialTarget.symbol, msg.slice(0, 100));
            } else {
              stats.borrowFail += 1;
              pushErr(stats, `bor ${specialTarget.symbol}: ${msg}`);
              log("BORROW FAIL", specialTarget.symbol, msg.slice(0, 160));
            }
          }
        }
        saveStats(stats);
      });
    }

    if (round % 25 === 0) {
      log("checkpoint", {
        round,
        buys: stats.buys,
        sells: stats.sells,
        fails: stats.fails,
        lev: `${stats.leverageOk}/${stats.leverageFail}`,
        bor: `${stats.borrowOk}/${stats.borrowFail}`,
        minsLeft: ((deadline - Date.now()) / 60_000).toFixed(1),
      });
    }

    // Stagger job submission so RPC isn't hammered
    await sleep(400 + Math.floor(Math.random() * 700));
  }

  await Promise.allSettled(workers);
  saveStats(stats);
  log("multi-trader stress done", stats);
}

main().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
