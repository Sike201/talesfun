/**
 * Top up inventory wallets with fee SOL, sell TALESFUN into the pool, sweep SOL to payer.
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

const ROOT = path.resolve(__dirname, "..");
const meta = JSON.parse(
  fs.readFileSync(path.join(ROOT, ".e2e-tmp/talesfun-test-mint.json"), "utf8")
) as { mint: string; gammPool: string };
const RPC =
  process.env.NEXT_PUBLIC_SOLANA_RPC_URL || "https://api.devnet.solana.com";
const mint = meta.mint;
const pool = meta.gammPool;

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

async function tokBal(connection: Connection, owner: PublicKey) {
  try {
    const ata = getAssociatedTokenAddressSync(new PublicKey(mint), owner, true);
    return Number(
      (await connection.getTokenAccountBalance(ata)).value.uiAmountString || 0
    );
  } catch {
    return 0;
  }
}

async function main() {
  const connection = new Connection(RPC, "confirmed");
  const payer = Keypair.fromSecretKey(
    Uint8Array.from(
      JSON.parse(
        fs.readFileSync(
          path.join(process.env.HOME!, ".config/solana/phantom.json"),
          "utf8"
        )
      )
    )
  );
  const idKp = Keypair.fromSecretKey(
    Uint8Array.from(
      JSON.parse(
        fs.readFileSync(
          path.join(process.env.HOME!, ".config/solana/id.json"),
          "utf8"
        )
      )
    )
  );

  // Also pick hackathon demo traders that still hold tokens.
  const sellers: Keypair[] = [idKp];
  const demoPath = path.join(ROOT, ".e2e-tmp/hackathon-demo-traders.json");
  if (fs.existsSync(demoPath)) {
    const rows = JSON.parse(fs.readFileSync(demoPath, "utf8")) as {
      secret: number[];
    }[];
    for (const row of rows) {
      try {
        sellers.push(Keypair.fromSecretKey(Uint8Array.from(row.secret)));
      } catch {
        /* ignore */
      }
    }
  }

  const payBal = await connection.getBalance(payer.publicKey);
  console.log("payer", (payBal / LAMPORTS_PER_SOL).toFixed(4));

  // Prefer the richest token wallet first (usually id.json / launch wallet).
  const ranked: { kp: Keypair; tokens: number }[] = [];
  for (const kp of sellers) {
    const tokens = await tokBal(connection, kp.publicKey);
    if (tokens > 50_000) ranked.push({ kp, tokens });
  }
  ranked.sort((a, b) => b.tokens - a.tokens);
  console.log(
    "sellers with inventory",
    ranked.map(r => `${r.kp.publicKey.toBase58().slice(0, 8)}:${r.tokens.toFixed(0)}`)
  );

  // Keep ~0.001 on payer; seed one seller at a time with the rest.
  let totalSold = 0;
  for (const { kp, tokens: startTok } of ranked.slice(0, 3)) {
    const payNow = await connection.getBalance(payer.publicKey);
    const feeEach = Math.min(2_000_000, Math.max(0, payNow - 1_200_000));
    const sol = await connection.getBalance(kp.publicKey);
    if (sol < 1_200_000) {
      if (feeEach < 900_000) {
        console.log("skip seed — payer exhausted");
        break;
      }
      const tx = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: payer.publicKey,
          toPubkey: kp.publicKey,
          lamports: feeEach,
        })
      );
      await sendAndConfirmTransaction(connection, tx, [payer], {
        commitment: "confirmed",
      });
      console.log(
        "seeded",
        kp.publicKey.toBase58().slice(0, 8),
        (feeEach / 1e9).toFixed(4),
        "had",
        startTok.toFixed(0)
      );
    }

    const snap = await fetchOmnipairPoolSnapshot(
      connection,
      pool,
      mint,
      kp.publicKey
    );
    if (!snap.ok) {
      console.log("snap fail", snap.message);
      continue;
    }

    let left = await tokBal(connection, kp.publicKey);
    console.log(
      "selling from",
      kp.publicKey.toBase58().slice(0, 8),
      "tokens",
      left.toFixed(0)
    );
    for (let i = 0; i < 6 && left > 20_000; i++) {
      // Keep sells tiny vs reserve so CPMM minOut stays achievable.
      const sellUi = Math.min(left * 0.08, 5_000_000);
      try {
        const r = await sendOmnipairSwapTx({
          connection,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          wallet: walletOf(kp) as any,
          snapshot: snap.data,
          side: "sell",
          amountUi: sellUi,
          slippagePercent: 40,
        });
        totalSold++;
        console.log(
          "SELL OK",
          kp.publicKey.toBase58().slice(0, 8),
          sellUi.toFixed(0),
          r.signature.slice(0, 16)
        );
        left = await tokBal(connection, kp.publicKey);
      } catch (e) {
        console.log(
          "SELL FAIL",
          kp.publicKey.toBase58().slice(0, 8),
          e instanceof Error ? e.message.slice(0, 140) : e
        );
        break;
      }
    }

    // Sweep SOL back to payer except dust.
    const after = await connection.getBalance(kp.publicKey);
    if (after > 25_000 && !kp.publicKey.equals(payer.publicKey)) {
      try {
        const lamports = after - 8_000;
        const tx = new Transaction().add(
          SystemProgram.transfer({
            fromPubkey: kp.publicKey,
            toPubkey: payer.publicKey,
            lamports,
          })
        );
        await sendAndConfirmTransaction(connection, tx, [kp], {
          commitment: "confirmed",
        });
        console.log(
          "swept",
          kp.publicKey.toBase58().slice(0, 8),
          (lamports / 1e9).toFixed(4)
        );
      } catch {
        /* ignore */
      }
    }
  }

  const final = await connection.getBalance(payer.publicKey);
  console.log(
    JSON.stringify(
      {
        sells: totalSold,
        payerSol: +(final / LAMPORTS_PER_SOL).toFixed(4),
      },
      null,
      2
    )
  );
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
