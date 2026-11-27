/**
 * Real-scenario Omnipair E2E on one graduated mint (default: talesfun test):
 * fund N traders → buy inventory → leverage sweep (1.5–5x long/short) →
 * borrow + swap mix. Persists every fill to activity (Supabase + local).
 *
 *   npx tsx --env-file=.env.local scripts/devnet-e2e-omnipair-real.ts
 *
 * Env:
 *   FOCUS_MINT=Jr9S1noL7o1pDSXMvGVZ44tC73D747Veb21ixxPNBnp
 *   TRADER_COUNT=12
 *   FUND_SOL=0.42
 *   STRESS_PAYER_KEYPAIR=~/.config/solana/phantom.json
 *   SKIP_FUND=0
 *   ROUNDS=3
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
import {
  clampLeverage,
  poolMaxLeverage,
  poolSafeCf,
} from "../src/lib/poolMaxLeverage";

const ROOT = path.resolve(__dirname, "..");
const TMP = path.join(ROOT, ".e2e-tmp");
const TRADERS_FILE = path.join(TMP, "multi-traders.json");
const LOG_FILE = path.join(TMP, "e2e-omnipair-real.log");
const STATS_FILE = path.join(TMP, "e2e-omnipair-real-stats.json");
const TALES_META = path.join(TMP, "talesfun-test-mint.json");

const RPC =
  process.env.NEXT_PUBLIC_SOLANA_RPC_URL || "https://api.devnet.solana.com";
const DEFAULT_MINT = (() => {
  try {
    const j = JSON.parse(fs.readFileSync(TALES_META, "utf8")) as {
      mint?: string;
    };
    return j.mint || "Jr9S1noL7o1pDSXMvGVZ44tC73D747Veb21ixxPNBnp";
  } catch {
    return "Jr9S1noL7o1pDSXMvGVZ44tC73D747Veb21ixxPNBnp";
  }
})();
const FOCUS_MINT = (process.env.FOCUS_MINT || DEFAULT_MINT).trim();
const TRADER_COUNT = Math.max(
  4,
  Math.min(20, Number(process.env.TRADER_COUNT || "12"))
);
const FUND_SOL = Math.max(0.15, Number(process.env.FUND_SOL || "0.42"));
const SKIP_FUND = process.env.SKIP_FUND === "1";
const ROUNDS = Math.max(1, Math.min(8, Number(process.env.ROUNDS || "3")));

/** Build 0.1-step sweep from 1.0 → pool Max (matches WakeSlider). */
function buildLevSweep(reserveSol: number): number[] {
  const maxLev = poolMaxLeverage(reserveSol);
  const out: number[] = [];
  for (let v = 1.0; v <= maxLev + 1e-9; v = Math.round((v + 0.1) * 10) / 10) {
    out.push(clampLeverage(v, maxLev));
  }
  // Always include Max endpoint once.
  if (out[out.length - 1] !== maxLev) out.push(maxLev);
  // Cap sweep length for runtime; keep start/mid/max denser.
  if (out.length <= 8) return out;
  const pick = new Set<number>([
    out[0]!,
    out[1]!,
    out[Math.floor(out.length / 3)]!,
    out[Math.floor((2 * out.length) / 3)]!,
    out[out.length - 2]!,
    out[out.length - 1]!,
  ]);
  return Array.from(pick).sort((a, b) => a - b);
}

type TraderRec = { secret: number[]; pubkey: string };
type Stats = {
  startedAt: string;
  mint: string;
  fundSolEach: number;
  buys: number;
  sells: number;
  leverageOk: number;
  leverageFail: number;
  borrowOk: number;
  borrowFail: number;
  byLeverage: Record<
    string,
    { ok: number; fail: number; lastError?: string }
  >;
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
  fs.mkdirSync(TMP, { recursive: true });
  fs.appendFileSync(LOG_FILE, line + "\n");
}

function isSoftSkip(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return /blockhash not found|block height exceeded|timed out|429|fetch failed|ECONNRESET|socket hang up|Too many requests|max usage reached|Transaction was not confirmed|simulation failed|custom program error: 0x1|insufficient|Attempt to debit|BorrowingPowerExceeded|0x177a|6010|6017|6025|IncorrectProgramId|Max practical leverage|thin pool|could not refresh/i.test(
    msg
  );
}

function loadPayer(): Keypair {
  const override = process.env.STRESS_PAYER_KEYPAIR?.trim();
  const phantom = path.join(process.env.HOME!, ".config/solana/phantom.json");
  const file =
    override && fs.existsSync(override)
      ? override
      : fs.existsSync(phantom)
        ? phantom
        : path.join(process.env.HOME!, ".config/solana/id.json");
  log("payer", file);
  return Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(file, "utf8")))
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

function loadTraders(): Keypair[] {
  fs.mkdirSync(TMP, { recursive: true });
  let raw: TraderRec[] = [];
  if (fs.existsSync(TRADERS_FILE)) {
    raw = JSON.parse(fs.readFileSync(TRADERS_FILE, "utf8")) as TraderRec[];
  }
  const kps = raw.slice(0, TRADER_COUNT).map((r) =>
    Keypair.fromSecretKey(Uint8Array.from(r.secret))
  );
  while (kps.length < TRADER_COUNT) kps.push(Keypair.generate());
  fs.writeFileSync(
    TRADERS_FILE,
    JSON.stringify(
      kps.map((kp) => ({
        secret: Array.from(kp.secretKey),
        pubkey: kp.publicKey.toBase58(),
      })),
      null,
      2
    )
  );
  return kps;
}

async function fundTraders(
  connection: Connection,
  payer: Keypair,
  traders: Keypair[]
) {
  const want = Math.floor(FUND_SOL * LAMPORTS_PER_SOL);
  const payerBal = await connection.getBalance(payer.publicKey);
  log("fund", {
    payerSol: +(payerBal / LAMPORTS_PER_SOL).toFixed(4),
    each: FUND_SOL,
    n: traders.length,
  });
  for (let i = 0; i < traders.length; i++) {
    const t = traders[i]!;
    const bal = await connection.getBalance(t.publicKey);
    if (bal >= want * 0.9) {
      log(`t#${i} ok`, (bal / LAMPORTS_PER_SOL).toFixed(4));
      continue;
    }
    const topUp = want - bal;
    const left = await connection.getBalance(payer.publicKey);
    if (left < topUp + 8_000_000) {
      log(`stop funding @ t#${i} payer=${(left / LAMPORTS_PER_SOL).toFixed(4)}`);
      break;
    }
    const tx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: payer.publicKey,
        toPubkey: t.publicKey,
        lamports: topUp,
      })
    );
    await sendAndConfirmTransaction(connection, tx, [payer], {
      commitment: "confirmed",
    });
    log(`t#${i} funded +${(topUp / LAMPORTS_PER_SOL).toFixed(4)}`);
    await sleep(250);
  }
}

async function tokenUiBalance(
  connection: Connection,
  mint: PublicKey,
  owner: PublicKey
): Promise<number> {
  try {
    const ata = getAssociatedTokenAddressSync(mint, owner, true);
    const bal = await connection.getTokenAccountBalance(ata);
    return Number(bal.value.uiAmountString || "0");
  } catch {
    return 0;
  }
}

async function resolvePool(
  connection: Connection,
  mintStr: string
): Promise<{ mint: string; symbol: string; gammPool: string }> {
  const mint = new PublicKey(mintStr);
  const program = getReadOnlyProgram(connection);
  const [pda] = getTokenStatePDA(mint);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const state = await (program.account as any).tokenState.fetch(pda);
  const token = tokenStateToToken(state, mintStr);
  if (!token.gammPool) throw new Error("mint has no gamm pool — not graduated?");
  return {
    mint: mintStr,
    symbol: token.ticker || token.symbol || "TOKEN",
    gammPool: token.gammPool,
  };
}

async function persist(
  mint: string,
  signature: string,
  side: "buy" | "sell" | "long" | "short" | "borrow",
  wallet: string,
  solUi: number,
  tokUi: number,
  priceSol: number
) {
  await upsertCanonicalTrade({
    mint,
    signature,
    side,
    sol_amount_raw: BigInt(Math.max(0, Math.floor(solUi * 1e9))).toString(),
    token_amount_raw: BigInt(Math.max(0, Math.floor(tokUi * 1e6))).toString(),
    timestamp: new Date().toISOString(),
    wallet,
    price_sol: priceSol,
    source: "omnipair",
  });
}

async function doBuy(
  connection: Connection,
  kp: Keypair,
  target: { mint: string; gammPool: string; symbol: string },
  solUi: number,
  stats: Stats
) {
  const snap = await fetchOmnipairPoolSnapshot(
    connection,
    target.gammPool,
    target.mint,
    kp.publicKey
  );
  if (!snap.ok) throw new Error(snap.message);
  const res = await sendOmnipairSwapTx({
    connection,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    wallet: walletOf(kp) as any,
    snapshot: snap.data,
    side: "buy",
    amountUi: solUi,
    slippagePercent: 12,
  });
  stats.buys += 1;
  await persist(
    target.mint,
    res.signature,
    "buy",
    kp.publicKey.toBase58(),
    solUi,
    Number(res.fill?.token_amount_raw || 0) / 1e6,
    snap.data.spotPriceSol
  );
  log("BUY", target.symbol, solUi.toFixed(4), res.signature.slice(0, 10));
}

async function doSell(
  connection: Connection,
  kp: Keypair,
  target: { mint: string; gammPool: string; symbol: string },
  tokUi: number,
  stats: Stats
) {
  const snap = await fetchOmnipairPoolSnapshot(
    connection,
    target.gammPool,
    target.mint,
    kp.publicKey
  );
  if (!snap.ok) throw new Error(snap.message);
  const res = await sendOmnipairSwapTx({
    connection,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    wallet: walletOf(kp) as any,
    snapshot: snap.data,
    side: "sell",
    amountUi: tokUi,
    slippagePercent: 12,
  });
  stats.sells += 1;
  await persist(
    target.mint,
    res.signature,
    "sell",
    kp.publicKey.toBase58(),
    Number(res.fill?.sol_amount_raw || 0) / 1e9,
    tokUi,
    snap.data.spotPriceSol
  );
  log("SELL", target.symbol, tokUi.toFixed(1), res.signature.slice(0, 10));
}

async function doLeverage(
  connection: Connection,
  kp: Keypair,
  target: { mint: string; gammPool: string; symbol: string },
  direction: "long" | "short",
  leverage: number,
  stats: Stats
) {
  const key = `${direction}@${leverage}x`;
  if (!stats.byLeverage[key]) stats.byLeverage[key] = { ok: 0, fail: 0 };
  const mint = new PublicKey(target.mint);
  const tok = await tokenUiBalance(connection, mint, kp.publicKey);
  const sol = (await connection.getBalance(kp.publicKey)) / LAMPORTS_PER_SOL;

  const snap = await fetchOmnipairPoolSnapshot(
    connection,
    target.gammPool,
    target.mint,
    kp.publicKey
  );
  if (!snap.ok) throw new Error(snap.message);
  const spot = snap.data.spotPriceSol;

  let marginUi: number;
  if (direction === "short") {
    // Keep short margin tiny vs thin SOL depth so borrow+sell can clear.
    marginUi = Math.min(0.018, Math.max(0.008, sol * 0.04));
    if (sol < 0.05) throw new Error("insufficient SOL for short margin");
  } else {
    if (tok < 80) throw new Error(`need project tokens for long (have ${tok})`);
    marginUi = Math.min(Math.max(tok * 0.04, 120), tok * 0.15);
  }

  const res = await sendOmnipairLeverageStepTx({
    connection,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    wallet: walletOf(kp) as any,
    snapshot: snap.data,
    direction,
    marginUi,
    leverage,
    slippagePercent: 12,
  });
  const primary = res.sigs[res.sigs.length - 1] || res.sigs[0]!;
  stats.leverageOk += 1;
  stats.byLeverage[key]!.ok += 1;
  await persist(
    target.mint,
    primary,
    direction,
    kp.publicKey.toBase58(),
    direction === "short" ? marginUi : marginUi * spot,
    direction === "long" ? marginUi : 0,
    spot
  );
  log(
    "LEV OK",
    target.symbol,
    direction,
    `${leverage}x`,
    `margin=${marginUi.toFixed(4)}`,
    primary.slice(0, 10)
  );
}

async function doBorrow(
  connection: Connection,
  kp: Keypair,
  target: { mint: string; gammPool: string; symbol: string },
  stats: Stats
) {
  const mint = new PublicKey(target.mint);
  const ui = await tokenUiBalance(connection, mint, kp.publicKey);
  if (!(ui > 40)) throw new Error(`need tokens for borrow (have ${ui})`);
  const snap = await fetchOmnipairPoolSnapshot(
    connection,
    target.gammPool,
    target.mint,
    kp.publicKey
  );
  if (!snap.ok) throw new Error(snap.message);
  const coll = Math.min(ui * 0.03, 8000);
  const res = await sendOmnipairBorrowAgainstProjectTx({
    connection,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    wallet: walletOf(kp) as any,
    snapshot: snap.data,
    collateralTokenUi: coll,
  });
  stats.borrowOk += 1;
  await persist(
    target.mint,
    res.borrowSig,
    "borrow",
    kp.publicKey.toBase58(),
    coll * snap.data.spotPriceSol * 0.22,
    coll,
    snap.data.spotPriceSol
  );
  log("BORROW OK", target.symbol, coll.toFixed(1), res.borrowSig.slice(0, 10));
}

function pushErr(stats: Stats, e: unknown) {
  const msg = e instanceof Error ? e.message : String(e);
  stats.lastErrors = [msg.slice(0, 220), ...stats.lastErrors].slice(0, 12);
}

async function main() {
  fs.mkdirSync(TMP, { recursive: true });
  if (fs.existsSync(LOG_FILE)) fs.renameSync(LOG_FILE, LOG_FILE + ".prev");
  const connection = new Connection(RPC, {
    commitment: "confirmed",
    confirmTransactionInitialTimeout: 90_000,
  });
  const payer = loadPayer();
  const traders = loadTraders();
  const target = await resolvePool(connection, FOCUS_MINT);
  const stats: Stats = {
    startedAt: new Date().toISOString(),
    mint: target.mint,
    fundSolEach: FUND_SOL,
    buys: 0,
    sells: 0,
    leverageOk: 0,
    leverageFail: 0,
    borrowOk: 0,
    borrowFail: 0,
    byLeverage: {},
    lastErrors: [],
  };
  const depthSnap = await fetchOmnipairPoolSnapshot(
    connection,
    target.gammPool,
    target.mint,
    null
  );
  if (!depthSnap.ok) throw new Error(depthSnap.message);
  const reserveSol = Number(depthSnap.data.reserveSolRaw) / 1e9;
  const maxLev = poolMaxLeverage(reserveSol);
  const LEV_SWEEP = buildLevSweep(reserveSol);
  log("E2E start", {
    mint: target.mint,
    symbol: target.symbol,
    pool: target.gammPool,
    traders: traders.length,
    rounds: ROUNDS,
    reserveSol: Number(reserveSol.toFixed(4)),
    safeCf: poolSafeCf(reserveSol),
    maxLev,
    levSweep: LEV_SWEEP,
    rpc: RPC.replace(/api-key=.*/, "api-key=***"),
  });

  if (!SKIP_FUND) {
    await fundTraders(connection, payer, traders);
  }

  // Phase A — accumulate inventory via buys (real swap path)
  log("phase A — multi-trader buys");
  for (let i = 0; i < traders.length; i++) {
    const kp = traders[i]!;
    const sol = (await connection.getBalance(kp.publicKey)) / LAMPORTS_PER_SOL;
    if (sol < 0.08) {
      log(`t#${i} skip buy — low SOL`, sol.toFixed(4));
      continue;
    }
    const buySol = Math.min(0.045 + Math.random() * 0.04, sol - 0.04);
    try {
      await doBuy(connection, kp, target, buySol, stats);
    } catch (e) {
      pushErr(stats, e);
      log("BUY FAIL", `t#${i}`, isSoftSkip(e) ? "soft" : "hard", String(e).slice(0, 160));
    }
    await sleep(800 + Math.floor(Math.random() * 700));
    fs.writeFileSync(STATS_FILE, JSON.stringify(stats, null, 2));
  }

  // Phase B1 — shorts first (dedicated even traders; avoid wallets already long)
  log("phase B1 — short leverage sweep", LEV_SWEEP.join(","));
  let shortCursor = 0;
  for (let round = 0; round < ROUNDS; round++) {
    for (const lev of LEV_SWEEP) {
      const kp = traders[(shortCursor * 2) % traders.length]!;
      shortCursor += 1;
      try {
        await doLeverage(connection, kp, target, "short", lev, stats);
      } catch (e) {
        stats.leverageFail += 1;
        const key = `short@${lev}x`;
        if (!stats.byLeverage[key]) stats.byLeverage[key] = { ok: 0, fail: 0 };
        stats.byLeverage[key]!.fail += 1;
        stats.byLeverage[key]!.lastError = (
          e instanceof Error ? e.message : String(e)
        ).slice(0, 180);
        pushErr(stats, e);
        log("LEV FAIL", "short", `${lev}x`, isSoftSkip(e) ? "soft" : "hard", String(e).slice(0, 180));
      }
      await sleep(1400 + Math.floor(Math.random() * 800));
      fs.writeFileSync(STATS_FILE, JSON.stringify(stats, null, 2));
    }
  }

  // Phase B2 — longs (odd traders) across leverage limits
  log("phase B2 — long leverage sweep", LEV_SWEEP.join(","));
  let longCursor = 0;
  for (let round = 0; round < ROUNDS; round++) {
    for (const lev of LEV_SWEEP) {
      const kp = traders[(longCursor * 2 + 1) % traders.length]!;
      longCursor += 1;
      try {
        await doLeverage(connection, kp, target, "long", lev, stats);
      } catch (e) {
        stats.leverageFail += 1;
        const key = `long@${lev}x`;
        if (!stats.byLeverage[key]) stats.byLeverage[key] = { ok: 0, fail: 0 };
        stats.byLeverage[key]!.fail += 1;
        stats.byLeverage[key]!.lastError = (
          e instanceof Error ? e.message : String(e)
        ).slice(0, 180);
        pushErr(stats, e);
        log("LEV FAIL", "long", `${lev}x`, isSoftSkip(e) ? "soft" : "hard", String(e).slice(0, 180));
      }
      await sleep(1200 + Math.floor(Math.random() * 700));
      fs.writeFileSync(STATS_FILE, JSON.stringify(stats, null, 2));
    }
  }

  // Phase C — borrow from traders that hold tokens but preferably no open long debt
  log("phase C — borrow");
  for (let i = 0; i < traders.length; i++) {
    if (i % 3 !== 0) continue;
    const kp = traders[i]!;
    try {
      await doBorrow(connection, kp, target, stats);
    } catch (e) {
      stats.borrowFail += 1;
      pushErr(stats, e);
      log("BORROW FAIL", `t#${i}`, isSoftSkip(e) ? "soft" : "hard", String(e).slice(0, 160));
    }
    await sleep(1100);
    fs.writeFileSync(STATS_FILE, JSON.stringify(stats, null, 2));
  }

  // Phase D — mixed sells (small chunks + high slippage for thin pools)
  log("phase D — sells");
  for (let i = 0; i < traders.length; i++) {
    const kp = traders[i]!;
    const tok = await tokenUiBalance(
      connection,
      new PublicKey(target.mint),
      kp.publicKey
    );
    if (tok < 80) continue;
    const sellUi = Math.min(tok * 0.08, 2500 + Math.random() * 4000);
    try {
      const snap = await fetchOmnipairPoolSnapshot(
        connection,
        target.gammPool,
        target.mint,
        kp.publicKey
      );
      if (!snap.ok) throw new Error(snap.message);
      const res = await sendOmnipairSwapTx({
        connection,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        wallet: walletOf(kp) as any,
        snapshot: snap.data,
        side: "sell",
        amountUi: sellUi,
        slippagePercent: 25,
      });
      stats.sells += 1;
      await persist(
        target.mint,
        res.signature,
        "sell",
        kp.publicKey.toBase58(),
        Number(res.fill?.sol_amount_raw || 0) / 1e9,
        sellUi,
        snap.data.spotPriceSol
      );
      log("SELL", target.symbol, sellUi.toFixed(1), res.signature.slice(0, 10));
    } catch (e) {
      pushErr(stats, e);
      log("SELL FAIL", `t#${i}`, String(e).slice(0, 140));
    }
    await sleep(900);
  }

  fs.writeFileSync(STATS_FILE, JSON.stringify(stats, null, 2));
  log("E2E done", {
    buys: stats.buys,
    sells: stats.sells,
    lev: `${stats.leverageOk}/${stats.leverageFail}`,
    borrow: `${stats.borrowOk}/${stats.borrowFail}`,
    byLeverage: stats.byLeverage,
  });
  console.log(JSON.stringify(stats, null, 2));
}

main().catch((e) => {
  console.error("E2E FATAL", e);
  process.exit(1);
});
