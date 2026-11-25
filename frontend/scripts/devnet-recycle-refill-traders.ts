/**
 * Sell trader inventory back to SOL, then equalize balances for continued stress.
 *   npx tsx --env-file=.env.local scripts/devnet-recycle-refill-traders.ts
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
const TRADERS_FILE = path.join(ROOT, ".e2e-tmp", "multi-traders.json");

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

async function tokBal(
  connection: Connection,
  mint: PublicKey,
  owner: PublicKey
) {
  try {
    const ata = getAssociatedTokenAddressSync(mint, owner);
    const bal = await connection.getTokenAccountBalance(ata, "confirmed");
    return Number(bal.value.uiAmountString || "0");
  } catch {
    return 0;
  }
}

async function main() {
  const connection = new Connection(
    process.env.NEXT_PUBLIC_SOLANA_RPC_URL || "https://api.devnet.solana.com",
    "confirmed"
  );
  const payer = Keypair.fromSecretKey(
    Uint8Array.from(
      JSON.parse(
        fs.readFileSync(
          path.join(process.env.HOME!, ".config/solana/id.json"),
          "utf8"
        )
      )
    )
  );
  const traders = (
    JSON.parse(fs.readFileSync(TRADERS_FILE, "utf8")) as { secret: number[] }[]
  ).map((r) => Keypair.fromSecretKey(Uint8Array.from(r.secret)));

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  const rows = (await (
    await fetch(
      `${url}/rest/v1/tokens?select=mint,symbol,gamm_pool&phase=eq.graduated&gamm_pool=not.is.null&limit=24`,
      { headers: { apikey: key, Authorization: `Bearer ${key}` } }
    )
  ).json()) as { mint: string; symbol: string; gamm_pool: string }[];

  let sells = 0;
  for (let i = 0; i < traders.length; i++) {
    const t = traders[i]!;
    for (const row of rows) {
      if (!row.gamm_pool) continue;
      const mint = new PublicKey(row.mint);
      const ui = await tokBal(connection, mint, t.publicKey);
      if (ui < 80) continue;
      const snap = await fetchOmnipairPoolSnapshot(
        connection,
        row.gamm_pool,
        row.mint,
        t.publicKey
      );
      if (!snap.ok) continue;
      const sellUi = Math.min(ui * 0.65, ui);
      try {
        await sendOmnipairSwapTx({
          connection,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          wallet: walletOf(t) as any,
          snapshot: snap.data,
          side: "sell",
          amountUi: sellUi,
          slippagePercent: 18,
        });
        sells += 1;
        console.log(`t#${i} sold ${row.symbol} ${sellUi.toFixed(0)}`);
        break;
      } catch (e) {
        console.log(
          `t#${i} sell fail ${row.symbol}`,
          e instanceof Error ? e.message.slice(0, 90) : e
        );
      }
    }
  }
  console.log("recycle sells", sells);

  const target = Math.floor(0.028 * LAMPORTS_PER_SOL);
  for (const t of traders) {
    const bal = await connection.getBalance(t.publicKey);
    if (bal > target + 4_000_000) {
      const send = bal - target;
      try {
        const tx = new Transaction().add(
          SystemProgram.transfer({
            fromPubkey: t.publicKey,
            toPubkey: payer.publicKey,
            lamports: send,
          })
        );
        await sendAndConfirmTransaction(connection, tx, [t], {
          commitment: "confirmed",
        });
        console.log(
          "sweep",
          t.publicKey.toBase58().slice(0, 6),
          (send / 1e9).toFixed(4)
        );
      } catch {
        /* ignore */
      }
    }
  }

  let left = await connection.getBalance(payer.publicKey);
  console.log("payer after sweep", left / 1e9);
  for (let i = 0; i < traders.length; i++) {
    if (left < target + 40_000_000) break;
    const bal = await connection.getBalance(traders[i]!.publicKey);
    if (bal >= target * 0.9) continue;
    const top = target - bal;
    if (top <= 0) continue;
    try {
      const tx = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: payer.publicKey,
          toPubkey: traders[i]!.publicKey,
          lamports: top,
        })
      );
      await sendAndConfirmTransaction(connection, tx, [payer], {
        commitment: "confirmed",
      });
      left -= top;
      console.log("refill", i, (top / 1e9).toFixed(4));
    } catch (e) {
      console.log("refill fail", e instanceof Error ? e.message : e);
      break;
    }
  }
  console.log(
    "payer final",
    (await connection.getBalance(payer.publicKey)) / 1e9
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
