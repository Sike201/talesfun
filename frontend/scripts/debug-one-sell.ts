import fs from "fs";
import path from "path";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { fetchOmnipairPoolSnapshot } from "../src/lib/omnipairPoolState";
import { sendOmnipairSwapTx } from "../src/lib/omnipairSwap";

async function main() {
  const meta = JSON.parse(
    fs.readFileSync(".e2e-tmp/talesfun-test-mint.json", "utf8")
  ) as { mint: string; gammPool: string };
  const mint = new PublicKey(meta.mint);
  const c = new Connection(process.env.NEXT_PUBLIC_SOLANA_RPC_URL!, "confirmed");

  const traders = JSON.parse(
    fs.readFileSync(".e2e-tmp/multi-stress-20-traders.json", "utf8")
  ) as { secret: number[] }[];

  let best: { kp: Keypair; ui: number } | null = null;
  for (const r of traders) {
    const kp = Keypair.fromSecretKey(Uint8Array.from(r.secret));
    try {
      const ata = getAssociatedTokenAddressSync(mint, kp.publicKey, true);
      const bal = await c.getTokenAccountBalance(ata);
      const ui = Number(bal.value.uiAmountString || 0);
      if (!best || ui > best.ui) best = { kp, ui };
    } catch {
      /* skip */
    }
  }
  if (!best) throw new Error("no holder");
  console.log(
    "best",
    best.kp.publicKey.toBase58(),
    "ui",
    best.ui,
    "sol",
    (await c.getBalance(best.kp.publicKey)) / 1e9
  );

  const snap = await fetchOmnipairPoolSnapshot(
    c,
    meta.gammPool,
    meta.mint,
    best.kp.publicKey
  );
  if (!snap.ok) throw new Error(snap.message);
  console.log("pool sol", Number(snap.data.reserveSolRaw) / 1e9);

  const wallet = {
    publicKey: best.kp.publicKey,
    signTransaction: async <T,>(tx: T) => {
      (tx as { partialSign: (k: Keypair) => void }).partialSign(best!.kp);
      return tx;
    },
    signAllTransactions: async <T,>(txs: T[]) => {
      for (const t of txs) {
        (t as { partialSign: (k: Keypair) => void }).partialSign(best!.kp);
      }
      return txs;
    },
  };

  const sellUi = Math.min(best.ui * 0.05, 15000);
  console.log("trying sell", sellUi);
  try {
    const sig = await sendOmnipairSwapTx({
      connection: c,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      wallet: wallet as any,
      snapshot: snap.data,
      side: "sell",
      amountUi: sellUi,
      slippagePercent: 40,
    });
    console.log("OK", sig);
  } catch (e: unknown) {
    const err = e as {
      message?: string;
      logs?: string[];
      getLogs?: () => Promise<string[]>;
      transactionMessage?: string;
      simulationResponse?: unknown;
    };
    console.error("FAIL message:", err?.message || String(e));
    if (typeof err?.getLogs === "function") {
      try {
        console.error("logs", await err.getLogs());
      } catch {
        /* */
      }
    }
    if (err?.logs) console.error("err.logs", err.logs.slice(-30));
    console.error("raw", e);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
