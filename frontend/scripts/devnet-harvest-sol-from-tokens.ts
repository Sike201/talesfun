/**
 * Sell TALESFUN inventory from id.json in tiny chunks → unwrap WSOL → sweep to phantom payer.
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
const meta = JSON.parse(
  fs.readFileSync(path.join(ROOT, ".e2e-tmp/talesfun-test-mint.json"), "utf8")
) as { mint: string; gammPool: string };

async function main() {
  const connection = new Connection(
    process.env.NEXT_PUBLIC_SOLANA_RPC_URL || "https://api.devnet.solana.com",
    "confirmed"
  );
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
  const id = Keypair.fromSecretKey(
    Uint8Array.from(
      JSON.parse(
        fs.readFileSync(
          path.join(process.env.HOME!, ".config/solana/id.json"),
          "utf8"
        )
      )
    )
  );
  const wallet = {
    publicKey: id.publicKey,
    signTransaction: async <T extends Transaction>(tx: T) => {
      tx.partialSign(id);
      return tx;
    },
    signAllTransactions: async <T extends Transaction>(txs: T[]) => {
      txs.forEach(t => t.partialSign(id));
      return txs;
    },
  };

  const tok = async () => {
    const ata = getAssociatedTokenAddressSync(
      new PublicKey(meta.mint),
      id.publicKey,
      true
    );
    return Number(
      (await connection.getTokenAccountBalance(ata)).value.uiAmountString || 0
    );
  };

  const need = 2_500_000;
  const pbal = await connection.getBalance(payer.publicKey);
  const ibal = await connection.getBalance(id.publicKey);
  console.log("payer", pbal / 1e9, "id", ibal / 1e9, "tokens", await tok());
  if (ibal < need && pbal > need + 1_000_000) {
    await sendAndConfirmTransaction(
      connection,
      new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: payer.publicKey,
          toPubkey: id.publicKey,
          lamports: need,
        })
      ),
      [payer],
      { commitment: "confirmed" }
    );
    console.log("seeded id");
  }

  const snap = await fetchOmnipairPoolSnapshot(
    connection,
    meta.gammPool,
    meta.mint,
    id.publicKey
  );
  if (!snap.ok) throw new Error(snap.message);

  let left = await tok();
  let ok = 0;
  const maxSells = Number(process.env.MAX_SELLS || "40");
  for (let i = 0; i < maxSells && left > 200_000; i++) {
    const sellUi = Math.min(750_000, Math.max(200_000, left * 0.008));
    try {
      const r = await sendOmnipairSwapTx({
        connection,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        wallet: wallet as any,
        snapshot: snap.data,
        side: "sell",
        amountUi: sellUi,
        slippagePercent: 35,
      });
      ok++;
      console.log("SELL", ok, sellUi.toFixed(0), r.signature.slice(0, 16));
      left = await tok();
      try {
        const wata = getAssociatedTokenAddressSync(
          NATIVE_MINT,
          id.publicKey,
          false,
          TOKEN_PROGRAM_ID
        );
        if (await connection.getAccountInfo(wata)) {
          await sendAndConfirmTransaction(
            connection,
            new Transaction().add(
              createCloseAccountInstruction(
                wata,
                id.publicKey,
                id.publicKey,
                [],
                TOKEN_PROGRAM_ID
              )
            ),
            [id],
            { commitment: "confirmed" }
          );
        }
      } catch {
        /* ignore */
      }
    } catch (e) {
      console.log(
        "FAIL",
        e instanceof Error ? e.message.slice(0, 160) : e
      );
      if (ok >= 5) break;
    }
  }

  const after = await connection.getBalance(id.publicKey);
  if (after > 20_000) {
    await sendAndConfirmTransaction(
      connection,
      new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: id.publicKey,
          toPubkey: payer.publicKey,
          lamports: after - 8_000,
        })
      ),
      [id],
      { commitment: "confirmed" }
    );
  }
  const final = await connection.getBalance(payer.publicKey);
  console.log(
    JSON.stringify(
      { sells: ok, payerSol: +(final / LAMPORTS_PER_SOL).toFixed(4) },
      null,
      2
    )
  );
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
