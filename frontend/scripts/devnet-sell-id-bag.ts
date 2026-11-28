/**
 * Sell TALESFUN bag on ~/.config/solana/id.json into the current test pool, unwrap, report.
 *   npx tsx --env-file=.env.local scripts/devnet-sell-id-bag.ts
 */
import fs from "node:fs";
import path from "node:path";
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
  LAMPORTS_PER_SOL,
  SystemProgram,
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
const META = path.join(ROOT, ".e2e-tmp/talesfun-test-mint.json");

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

async function tokUi(connection: Connection, mint: PublicKey, owner: PublicKey) {
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
    if (!(await connection.getAccountInfo(ata))) return;
    const tx = new Transaction().add(
      createCloseAccountInstruction(ata, kp.publicKey, kp.publicKey, [], TOKEN_PROGRAM_ID)
    );
    await sendAndConfirmTransaction(connection, tx, [kp], {
      commitment: "confirmed",
      maxRetries: 2,
    });
  } catch {
    /* skip */
  }
}

async function main() {
  const meta = JSON.parse(fs.readFileSync(META, "utf8")) as {
    mint: string;
    gammPool: string;
  };
  const mint = new PublicKey(meta.mint);
  const pool = meta.gammPool;
  const connection = new Connection(
    process.env.NEXT_PUBLIC_SOLANA_RPC_URL || "https://api.devnet.solana.com",
    "confirmed"
  );
  const id = Keypair.fromSecretKey(
    Uint8Array.from(
      JSON.parse(
        fs.readFileSync(path.join(process.env.HOME!, ".config/solana/id.json"), "utf8")
      )
    )
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

  const beforeId = await connection.getBalance(id.publicKey);
  const beforeExc = await connection.getBalance(community.publicKey);
  let ui = await tokUi(connection, mint, id.publicKey);
  console.log({
    id: id.publicKey.toBase58(),
    beforeIdSol: beforeId / LAMPORTS_PER_SOL,
    beforeExcSol: beforeExc / LAMPORTS_PER_SOL,
    tok: ui,
  });

  let sellOk = 0;
  let soldUi = 0;
  for (let round = 1; round <= 12; round++) {
    ui = await tokUi(connection, mint, id.publicKey);
    if (ui < 40) break;
    const snap = await fetchOmnipairPoolSnapshot(
      connection,
      pool,
      mint.toBase58(),
      id.publicKey
    );
    if (!snap.ok) throw new Error(snap.message);
    const poolSol = Number(snap.data.reserveSolRaw) / 1e9;
    const poolTok =
      Number(snap.data.reserveProjectRaw) / 10 ** snap.data.projectTokenDecimals;
    console.log(`round ${round} pool=${poolSol.toFixed(4)} SOL tokBag=${ui.toFixed(0)}`);
    if (poolSol < 0.05) {
      console.log("pool too thin");
      break;
    }
    const sellUi = Math.min(ui * 0.95, poolTok * 0.12, ui);
    if (sellUi < 40) break;
    try {
      await sendOmnipairSwapTx({
        connection,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        wallet: walletOf(id) as any,
        snapshot: snap.data,
        side: "sell",
        amountUi: sellUi,
        slippagePercent: 40,
      });
      sellOk++;
      soldUi += sellUi;
      console.log("SELL ok", sellUi.toFixed(0));
      await unwrapWsol(connection, id);
    } catch (e) {
      console.log(
        "SELL fail",
        e instanceof Error ? e.message.slice(0, 140) : e
      );
      break;
    }
  }

  await unwrapWsol(connection, id);
  const afterId = await connection.getBalance(id.publicKey);
  const send = afterId - 2_000_000;
  if (send > 50_000) {
    const tx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: id.publicKey,
        toPubkey: community.publicKey,
        lamports: send,
      })
    );
    await sendAndConfirmTransaction(connection, tx, [id], {
      commitment: "confirmed",
    });
  }
  const afterExc = await connection.getBalance(community.publicKey);
  const leftTok = await tokUi(connection, mint, id.publicKey);
  const leftIdSol = (await connection.getBalance(id.publicKey)) / LAMPORTS_PER_SOL;
  console.log(
    JSON.stringify(
      {
        sellOk,
        soldUi,
        leftTok,
        idSol: leftIdSol,
        excSol: afterExc / LAMPORTS_PER_SOL,
        totalExcPlusId: afterExc / LAMPORTS_PER_SOL + leftIdSol,
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
