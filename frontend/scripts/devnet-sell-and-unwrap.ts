/**
 * Sell project tokens on Omnipair (post-graduation) and unwrap WSOL → native SOL.
 * Usage: npx tsx --env-file=.env.local scripts/devnet-sell-and-unwrap.ts <mint>
 */
import fs from "node:fs";
import path from "node:path";
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  SystemProgram,
} from "@solana/web3.js";
import {
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
  createCloseAccountInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import {
  getReadOnlyProgram,
  getTokenStatePDA,
  tokenStateToToken,
} from "../src/lib/program";
import { fetchOmnipairPoolSnapshot } from "../src/lib/omnipairPoolState";
import { sendOmnipairSwapTx } from "../src/lib/omnipairSwap";
import { upsertLocalTrade } from "../src/lib/localTradeStore";

async function main() {
  const mintStr = process.argv[2];
  if (!mintStr) throw new Error("Usage: … <mint>");
  const mint = new PublicKey(mintStr);

  const secret = JSON.parse(
    fs.readFileSync(
      path.join(process.env.HOME!, ".config/solana/id.json"),
      "utf8"
    )
  ) as number[];
  const kp = Keypair.fromSecretKey(Uint8Array.from(secret));
  const connection = new Connection(
    process.env.NEXT_PUBLIC_SOLANA_RPC_URL || "https://api.devnet.solana.com",
    "confirmed"
  );

  const wallet = {
    publicKey: kp.publicKey,
    signTransaction: async <T extends Transaction>(tx: T) => {
      tx.partialSign(kp);
      return tx;
    },
    signAllTransactions: async <T extends Transaction>(txs: T[]) => {
      for (const tx of txs) tx.partialSign(kp);
      return txs;
    },
  };

  const before = await connection.getBalance(kp.publicKey);
  const program = getReadOnlyProgram(connection);
  const [pda] = getTokenStatePDA(mint);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const state = await (program.account as any).tokenState.fetch(pda);
  const token = tokenStateToToken(state, mintStr);
  if (!token.gammPool) throw new Error("token has no gamm pool yet");

  const ata = getAssociatedTokenAddressSync(mint, kp.publicKey);
  const bal = await connection.getTokenAccountBalance(ata, "confirmed").catch(() => null);
  const raw = bal?.value.amount ?? "0";
  const ui = Number(bal?.value.uiAmountString ?? "0");
  console.log("token balance", ui, "raw", raw);
  if (raw === "0" || !(ui > 0)) {
    console.log("nothing to sell");
  } else {
    const snap = await fetchOmnipairPoolSnapshot(
      connection,
      token.gammPool,
      mintStr,
      kp.publicKey
    );
    if (!snap.ok) throw new Error(snap.message);
    // Leave a dust so ATA stays open if needed; sell ~99.5% for reclaim.
    const sellUi = Math.max(0, ui * 0.995);
    console.log("selling", sellUi, "via Omnipair @", snap.data.spotPriceSol, "SOL");
    const res = await sendOmnipairSwapTx({
      connection,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      wallet: wallet as any,
      snapshot: snap.data,
      side: "sell",
      amountUi: sellUi,
      slippagePercent: 5,
    });
    console.log("sell sig", res.signature);
    try {
      const fill = res.fill;
      upsertLocalTrade({
        mint: mintStr,
        signature: res.signature,
        side: "sell",
        sol_amount_raw: fill?.sol_amount_raw ?? String(Math.floor(sellUi * snap.data.spotPriceSol * 1e9)),
        token_amount_raw:
          fill?.token_amount_raw ??
          String(Math.floor(sellUi * 10 ** snap.data.projectTokenDecimals)),
        timestamp: fill?.timestamp ?? new Date().toISOString(),
        wallet: kp.publicKey.toBase58(),
        price_sol: fill?.price_sol ?? snap.data.spotPriceSol,
        source: "omnipair",
      });
      console.log("local trade journal updated");
    } catch (e) {
      console.warn("local trade journal failed", e);
    }
  }

  // Unwrap any WSOL ATA back to native SOL.
  const wsolAta = getAssociatedTokenAddressSync(NATIVE_MINT, kp.publicKey);
  const wsolInfo = await connection.getAccountInfo(wsolAta, "confirmed");
  if (wsolInfo) {
    const wbal = await connection.getTokenAccountBalance(wsolAta, "confirmed");
    console.log("unwrapping WSOL", wbal.value.uiAmountString);
    const tx = new Transaction().add(
      createCloseAccountInstruction(
        wsolAta,
        kp.publicKey,
        kp.publicKey,
        [],
        TOKEN_PROGRAM_ID
      )
    );
    // Keep rent for empty account close — closeAccount returns rent + WSOL.
    tx.feePayer = kp.publicKey;
    const { blockhash } = await connection.getLatestBlockhash("confirmed");
    tx.recentBlockhash = blockhash;
    tx.sign(kp);
    const sig = await connection.sendRawTransaction(tx.serialize());
    await connection.confirmTransaction(sig, "confirmed");
    console.log("unwrap sig", sig);
  } else {
    console.log("no WSOL ATA to unwrap");
  }

  // Avoid unused import lint if tree-shaken oddly
  void SystemProgram;

  const after = await connection.getBalance(kp.publicKey);
  console.log("SOL reclaim", {
    before: before / 1e9,
    after: after / 1e9,
    delta: (after - before) / 1e9,
  });
  process.exit(0);
}

main().catch((e) => {
  console.error("SELL FAIL", e);
  process.exit(1);
});
