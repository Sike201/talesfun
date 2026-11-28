/**
 * E2E: open + close for long / short / borrow on the talesfun test mint.
 * Logs every wallet signature and whether close was 1-tx.
 *
 *   npx tsx --env-file=.env.local scripts/devnet-e2e-open-close-cases.ts
 *   ROUNDS=2 MINT=... npx tsx --env-file=.env.local scripts/devnet-e2e-open-close-cases.ts
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
import {
  fetchOmnipairUserPosition,
  sendOmnipairBorrowAgainstProjectTx,
  sendOmnipairClosePositionTx,
  sendOmnipairLeverageStepTx,
} from "../src/lib/omnipairLending";
import { sendOmnipairSwapTx } from "../src/lib/omnipairSwap";
import { poolMaxLeverage } from "../src/lib/poolMaxLeverage";

const ROOT = path.resolve(__dirname, "..");
const metaPath = path.join(ROOT, ".e2e-tmp/talesfun-test-mint.json");
const meta = JSON.parse(fs.readFileSync(metaPath, "utf8")) as {
  mint: string;
  gammPool: string;
};
const MINT = process.env.MINT || meta.mint;
const POOL = process.env.POOL || meta.gammPool;
const RPC =
  process.env.NEXT_PUBLIC_SOLANA_RPC_URL || "https://api.devnet.solana.com";
const ROUNDS = Math.max(1, Math.min(5, Number(process.env.ROUNDS || "2") || 2));
const OUT = path.join(ROOT, ".e2e-tmp/open-close-cases-report.json");

type CaseName = "long" | "short" | "borrow";
type CaseRow = {
  case: CaseName;
  round: number;
  openOk: boolean;
  closeOk: boolean;
  openSigCount: number;
  closeSigCount: number;
  openSigs: string[];
  closeSigs: string[];
  alreadyClosed?: boolean;
  error?: string;
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

function logCase(row: CaseRow) {
  const openNote =
    row.openSigCount === 1
      ? "OPEN 1-sig ✓"
      : `OPEN ${row.openSigCount}-sig ${row.openSigCount <= 1 ? "✓" : "⚠"}`;
  const closeNote = row.alreadyClosed
    ? "CLOSE already-closed (0-sig, no wallet)"
    : row.closeSigCount === 1
      ? "CLOSE 1-sig ✓"
      : `CLOSE ${row.closeSigCount}-sig ${row.closeOk ? (row.closeSigCount === 0 ? "✗" : "⚠") : "✗"}`;
  console.log(
    `\n══ ${row.case.toUpperCase()} round ${row.round} ══ ${row.openOk && row.closeOk ? "PASS" : "FAIL"} (${row.ms}ms)`
  );
  console.log(`  ${openNote}`);
  for (const s of row.openSigs) console.log(`    open  ${s}`);
  console.log(`  ${closeNote}`);
  for (const s of row.closeSigs) console.log(`    close ${s}`);
  if (row.error) console.log(`  error: ${row.error}`);
}

async function ensureFreshPosition(
  connection: Connection,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  wallet: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  snapshot: any
) {
  const pos = await fetchOmnipairUserPosition({ connection, wallet, snapshot });
  if (!pos) return;
  const live =
    pos.collateral0 > BigInt(0) ||
    pos.collateral1 > BigInt(0) ||
    pos.debt0Raw > BigInt(0) ||
    pos.debt1Raw > BigInt(0);
  if (!live) return;
  console.log("  clearing leftover position before case…");
  const r = await sendOmnipairClosePositionTx({
    connection,
    wallet,
    snapshot,
  });
  console.log(
    `  leftover close: ${r.sigs.length} sig(s)`,
    r.alreadyClosed ? "(already closed)" : r.sigs.join(", ")
  );
}

async function main() {
  const payerSecret = JSON.parse(
    fs.readFileSync(
      path.join(process.env.HOME!, ".config/solana/phantom.json"),
      "utf8"
    )
  ) as number[];
  const payer = Keypair.fromSecretKey(Uint8Array.from(payerSecret));
  const connection = new Connection(RPC, "confirmed");
  console.log("RPC", RPC.replace(/api-key=[^&]+/, "api-key=***"));
  console.log("mint", MINT);
  console.log("pool", POOL);
  console.log("payer", payer.publicKey.toBase58());
  console.log("rounds", ROUNDS);

  const snap0 = await fetchOmnipairPoolSnapshot(connection, POOL, MINT, null);
  if (!snap0.ok) throw new Error(snap0.message);
  const reserveSol = Number(snap0.data.reserveSolRaw) / 1e9;
  const maxLev = poolMaxLeverage(reserveSol);
  console.log(
    `pool spot=${snap0.data.spotPriceSol} reserveSol=${reserveSol.toFixed(3)} maxLev=${maxLev}x`
  );

  const rows: CaseRow[] = [];
  const cases: CaseName[] = ["borrow", "long", "short"];

  for (let round = 1; round <= ROUNDS; round++) {
    for (const name of cases) {
      const t0 = Date.now();
      const trader = Keypair.generate();
      const wallet = walletOf(trader);
      const row: CaseRow = {
        case: name,
        round,
        openOk: false,
        closeOk: false,
        openSigCount: 0,
        closeSigCount: 0,
        openSigs: [],
        closeSigs: [],
        ms: 0,
      };

      try {
        // Fund trader (keep lean — devnet faucet is tight)
        const fundSol = name === "short" ? 0.055 : 0.048;
        const fundTx = new Transaction().add(
          SystemProgram.transfer({
            fromPubkey: payer.publicKey,
            toPubkey: trader.publicKey,
            lamports: Math.floor(fundSol * LAMPORTS_PER_SOL),
          })
        );
        await sendAndConfirmTransaction(connection, fundTx, [payer], {
          commitment: "confirmed",
        });

        // Buy some project tokens for long/borrow collateral
        if (name === "long" || name === "borrow") {
          const buy = await sendOmnipairSwapTx({
            connection,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            wallet: wallet as any,
            snapshot: snap0.data,
            side: "buy",
            amountUi: name === "borrow" ? 0.018 : 0.015,
            slippagePercent: 12,
          });
          console.log(
            `  [${name} r${round}] bought tokens via ${buy.signature}`
          );
        }

        const snap = await fetchOmnipairPoolSnapshot(
          connection,
          POOL,
          MINT,
          trader.publicKey
        );
        if (!snap.ok) throw new Error(snap.message);

        await ensureFreshPosition(connection, wallet, snap.data);

        // OPEN
        if (name === "borrow") {
          const ata = getAssociatedTokenAddressSync(
            new PublicKey(MINT),
            trader.publicKey,
            true
          );
          const bal = await connection.getTokenAccountBalance(ata);
          const ui = Number(bal.value.uiAmountString || "0");
          const coll = Math.min(ui * 0.85, ui);
          if (!(coll > 0)) throw new Error("no tokens for borrow collateral");
          const opened = await sendOmnipairBorrowAgainstProjectTx({
            connection,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            wallet: wallet as any,
            snapshot: snap.data,
            collateralTokenUi: coll,
          });
          row.openSigs = opened.sigs.filter(s => !s.includes("already"));
          row.openSigCount = row.openSigs.length;
          row.openOk = row.openSigCount >= 1;
        } else {
          const lev = Math.min(1.2, maxLev);
          const marginUi = name === "short" ? 0.015 : undefined;
          let tokens = 0;
          if (name === "long") {
            const ata = getAssociatedTokenAddressSync(
              new PublicKey(MINT),
              trader.publicKey,
              true
            );
            const bal = await connection.getTokenAccountBalance(ata);
            tokens = Number(bal.value.uiAmountString || "0");
          }
          const opened = await sendOmnipairLeverageStepTx({
            connection,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            wallet: wallet as any,
            snapshot: snap.data,
            direction: name,
            marginUi:
              name === "short"
                ? marginUi!
                : Math.max(tokens * 0.7, 1),
            leverage: lev,
            slippagePercent: 12,
          });
          row.openSigs = opened.sigs;
          row.openSigCount = opened.sigs.length;
          row.openOk = opened.sigs.length >= 1;
        }

        // Verify on-chain position exists
        const mid = await fetchOmnipairUserPosition({
          connection,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          wallet: wallet as any,
          snapshot: snap.data,
        });
        if (
          !mid ||
          !(
            mid.collateral0 > BigInt(0) ||
            mid.collateral1 > BigInt(0) ||
            mid.debt0Raw > BigInt(0) ||
            mid.debt1Raw > BigInt(0)
          )
        ) {
          throw new Error("open reported ok but no live on-chain position");
        }

        // CLOSE
        const closed = await sendOmnipairClosePositionTx({
          connection,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          wallet: wallet as any,
          snapshot: snap.data,
          direction: name === "borrow" ? "borrow" : name,
        });
        row.closeSigs = closed.sigs;
        row.closeSigCount = closed.sigs.length;
        row.alreadyClosed = closed.alreadyClosed;
        row.closeOk =
          !closed.alreadyClosed &&
          closed.sigs.length >= 1 &&
          closed.sigs.every(s => s.length > 40);

        // Verify cleared
        const after = await fetchOmnipairUserPosition({
          connection,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          wallet: wallet as any,
          snapshot: snap.data,
        });
        const stillLive =
          after &&
          (after.collateral0 > BigInt(0) ||
            after.collateral1 > BigInt(0) ||
            after.debt0Raw > BigInt(0) ||
            after.debt1Raw > BigInt(0));
        if (stillLive) {
          row.closeOk = false;
          row.error = (row.error ? row.error + "; " : "") + "position still live after close";
        }
      } catch (e) {
        row.error = e instanceof Error ? e.message : String(e);
        row.openOk = row.openOk && row.openSigCount > 0;
        row.closeOk = false;
      }

      row.ms = Date.now() - t0;
      rows.push(row);
      logCase(row);
    }
  }

  const summary = {
    at: new Date().toISOString(),
    mint: MINT,
    pool: POOL,
    rounds: ROUNDS,
    rows,
    totals: {
      pass: rows.filter(r => r.openOk && r.closeOk).length,
      fail: rows.filter(r => !(r.openOk && r.closeOk)).length,
      closeOneSig: rows.filter(r => r.closeOk && r.closeSigCount === 1).length,
      closeMultiSig: rows.filter(r => r.closeOk && r.closeSigCount > 1).length,
      closeZeroSigBug: rows.filter(
        r => r.closeSigCount === 0 && !r.alreadyClosed && r.openOk
      ).length,
    },
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(summary, null, 2));

  console.log("\n════════ SUMMARY ════════");
  console.log(JSON.stringify(summary.totals, null, 2));
  console.log("report →", OUT);

  if (summary.totals.fail > 0 || summary.totals.closeZeroSigBug > 0) {
    process.exit(1);
  }
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
