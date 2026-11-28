/**
 * Sell leftover project tokens from all .e2e-tmp trader wallets on Omnipair,
 * unwrap WSOL, sweep native SOL into EXC (phantom.json).
 *
 *   npx tsx --env-file=.env.local scripts/devnet-sell-all-sweep.ts
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
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
  createCloseAccountInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { fetchOmnipairPoolSnapshot } from "../src/lib/omnipairPoolState";
import { sendOmnipairSwapTx } from "../src/lib/omnipairSwap";

const ROOT = path.resolve(__dirname, "..");
const TMP = path.join(ROOT, ".e2e-tmp");
const META = path.join(TMP, "talesfun-test-mint.json");
const FEE_DUST = 0.0045; // SOL to cover sell + unwrap rent

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
  const seen = new Set<string>();
  const out: Keypair[] = [];
  for (const f of fs.readdirSync(TMP)) {
    if (!f.endsWith(".json")) continue;
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(TMP, f), "utf8"));
      const rows = Array.isArray(raw) ? raw : raw?.secret ? [raw] : [];
      for (const r of rows) {
        if (!r?.secret) continue;
        const kp = Keypair.fromSecretKey(Uint8Array.from(r.secret));
        const id = kp.publicKey.toBase58();
        if (seen.has(id)) continue;
        seen.add(id);
        out.push(kp);
      }
    } catch {
      /* skip */
    }
  }
  return out;
}

async function tokUi(
  connection: Connection,
  mint: PublicKey,
  owner: PublicKey
): Promise<number> {
  try {
    const ata = getAssociatedTokenAddressSync(mint, owner, true);
    const bal = await connection.getTokenAccountBalance(ata, "confirmed");
    return Number(bal.value.uiAmountString || "0");
  } catch {
    return 0;
  }
}

async function unwrapWsol(connection: Connection, kp: Keypair) {
  try {
    const ata = getAssociatedTokenAddressSync(
      NATIVE_MINT,
      kp.publicKey,
      false,
      TOKEN_PROGRAM_ID
    );
    const info = await connection.getAccountInfo(ata);
    if (!info) return false;
    const tx = new Transaction().add(
      createCloseAccountInstruction(
        ata,
        kp.publicKey,
        kp.publicKey,
        [],
        TOKEN_PROGRAM_ID
      )
    );
    await sendAndConfirmTransaction(connection, tx, [kp], {
      commitment: "confirmed",
      maxRetries: 2,
    });
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const meta = JSON.parse(fs.readFileSync(META, "utf8")) as {
    mint: string;
    gammPool: string;
    ticker?: string;
  };
  const mint = new PublicKey(meta.mint);
  const pool = meta.gammPool;
  const ticker = meta.ticker || "TOKEN";

  const connection = new Connection(
    process.env.NEXT_PUBLIC_SOLANA_RPC_URL || "https://api.devnet.solana.com",
    "confirmed"
  );
  const community = Keypair.fromSecretKey(
    Uint8Array.from(
      JSON.parse(
        fs.readFileSync(
          path.join(process.env.HOME!, ".config/solana/phantom.json"),
          "utf8"
        )
      )
    )
  );

  const before = await connection.getBalance(community.publicKey);
  console.log(
    "community before",
    community.publicKey.toBase58(),
    (before / LAMPORTS_PER_SOL).toFixed(4),
    "SOL"
  );
  console.log("mint", mint.toBase58(), "pool", pool);

  const snap0 = await fetchOmnipairPoolSnapshot(connection, pool, mint.toBase58(), null);
  if (!snap0.ok) throw new Error(snap0.message);
  const reserveSol0 = Number(snap0.data.reserveSolRaw) / 1e9;
  console.log("pool reserve SOL", reserveSol0.toFixed(4), "spot", snap0.data.spotPriceSol);

  const traders = loadTraders().filter(
    (t) => !t.publicKey.equals(community.publicKey)
  );
  const holdings: { kp: Keypair; ui: number }[] = [];
  for (const kp of traders) {
    const ui = await tokUi(connection, mint, kp.publicKey);
    if (ui >= 50) holdings.push({ kp, ui });
  }
  holdings.sort((a, b) => b.ui - a.ui);
  console.log(
    "holders with ≥50 tokens",
    holdings.length,
    "total",
    holdings.reduce((s, h) => s + h.ui, 0).toFixed(0)
  );

  // Fund dust for fee-less wallets (need SOL to sell)
  let dustFunded = 0;
  for (const { kp, ui } of holdings) {
    const bal = await connection.getBalance(kp.publicKey);
    if (bal >= Math.floor(FEE_DUST * LAMPORTS_PER_SOL * 0.85)) continue;
    const need = Math.floor(FEE_DUST * LAMPORTS_PER_SOL) - bal;
    if (need <= 0) continue;
    const communityBal = await connection.getBalance(community.publicKey);
    if (communityBal < need + 40_000_000) {
      console.log("stop dust funding — community low");
      break;
    }
    try {
      const tx = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: community.publicKey,
          toPubkey: kp.publicKey,
          lamports: need,
        })
      );
      await sendAndConfirmTransaction(connection, tx, [community], {
        commitment: "confirmed",
      });
      dustFunded++;
      console.log(
        "dust",
        kp.publicKey.toBase58().slice(0, 8),
        (need / 1e9).toFixed(4),
        "ui",
        ui.toFixed(0)
      );
    } catch (e) {
      console.log(
        "dust fail",
        kp.publicKey.toBase58().slice(0, 8),
        e instanceof Error ? e.message.slice(0, 80) : e
      );
    }
  }
  console.log("dust funded", dustFunded);

  // Sell in rounds — never take more than ~18% of pool SOL per sell to keep fills alive
  let sellOk = 0;
  let sellFail = 0;
  let soldUi = 0;

  for (let round = 1; round <= 4; round++) {
    const snapR = await fetchOmnipairPoolSnapshot(
      connection,
      pool,
      mint.toBase58(),
      null
    );
    if (!snapR.ok) break;
    const rSol = Number(snapR.data.reserveSolRaw) / 1e9;
    const rTok =
      Number(snapR.data.reserveProjectRaw) /
      10 ** snapR.data.projectTokenDecimals;
    console.log(
      `\n=== sell round ${round} pool=${rSol.toFixed(3)} SOL / ${rTok.toFixed(0)} ${ticker} ===`
    );
    if (rSol < 0.08) {
      console.log("pool too thin — stop selling");
      break;
    }

    for (const { kp } of holdings) {
      const ui = await tokUi(connection, mint, kp.publicKey);
      if (ui < 50) continue;
      const bal = await connection.getBalance(kp.publicKey);
      if (bal < 2_500_000) continue;

      const snap = await fetchOmnipairPoolSnapshot(
        connection,
        pool,
        mint.toBase58(),
        kp.publicKey
      );
      if (!snap.ok) continue;
      const poolSol = Number(snap.data.reserveSolRaw) / 1e9;
      const poolTok =
        Number(snap.data.reserveProjectRaw) /
        10 ** snap.data.projectTokenDecimals;
      if (poolSol < 0.06 || poolTok <= 0) break;

      // Cap sell so we don't empty the pool in one hit (~12% of token reserve)
      const maxByPool = poolTok * 0.12;
      const sellUi = Math.min(ui * 0.92, maxByPool, ui);
      if (sellUi < 40) continue;

      try {
        await sendOmnipairSwapTx({
          connection,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          wallet: walletOf(kp) as any,
          snapshot: snap.data,
          side: "sell",
          amountUi: sellUi,
          slippagePercent: 35,
        });
        sellOk++;
        soldUi += sellUi;
        console.log(
          `SELL ok ${kp.publicKey.toBase58().slice(0, 8)} ${sellUi.toFixed(0)} ${ticker}`
        );
        await unwrapWsol(connection, kp);
      } catch (e) {
        sellFail++;
        const msg =
          e instanceof Error
            ? e.message || e.name || "Error"
            : String(e);
        console.log(
          `SELL fail ${kp.publicKey.toBase58().slice(0, 8)}`,
          msg.slice(0, 120)
        );
      }
    }
  }

  console.log("\n=== unwrap + sweep to community ===");
  let swept = 0;
  let sweptN = 0;
  for (const kp of traders) {
    await unwrapWsol(connection, kp);
    const bal = await connection.getBalance(kp.publicKey);
    const send = bal - 1_000_000;
    if (send <= 20_000) continue;
    try {
      const tx = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: kp.publicKey,
          toPubkey: community.publicKey,
          lamports: send,
        })
      );
      await sendAndConfirmTransaction(connection, tx, [kp], {
        commitment: "confirmed",
        maxRetries: 2,
      });
      swept += send;
      sweptN++;
    } catch {
      /* skip */
    }
  }

  const after = await connection.getBalance(community.publicKey);
  const snapF = await fetchOmnipairPoolSnapshot(connection, pool, mint.toBase58(), null);
  console.log(
    JSON.stringify(
      {
        sellOk,
        sellFail,
        soldUi,
        sweptWallets: sweptN,
        sweptSol: swept / LAMPORTS_PER_SOL,
        communityBefore: before / LAMPORTS_PER_SOL,
        communityAfter: after / LAMPORTS_PER_SOL,
        poolSolAfter: snapF.ok
          ? Number(snapF.data.reserveSolRaw) / 1e9
          : null,
        spotAfter: snapF.ok ? snapF.data.spotPriceSol : null,
      },
      null,
      2
    )
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
