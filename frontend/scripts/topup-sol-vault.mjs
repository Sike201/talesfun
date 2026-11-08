#!/usr/bin/env node
/**
 * Send SOL to a token's `sol_vault` PDA so legacy mints can satisfy rent + `real_sol_reserve`.
 * Safe: plain SystemProgram.transfer to the vault address; no program changes.
 *
 * Usage (from `frontend/` so `@solana/web3.js` resolves):
 *   node scripts/topup-sol-vault.mjs <MINT_PUBKEY> [SOL_AMOUNT]
 *
 * If SOL_AMOUNT is omitted, sends the cluster's rent-exempt minimum for a 0-byte account
 * (enough to cover the cushion when the vault is empty).
 *
 * Env:
 *   SOLANA_RPC_URL   — optional (default: mainnet-beta public RPC; use devnet URL for devnet)
 *   KEYPAIR_PATH     — optional JSON keypair path (default: ~/.config/solana/id.json)
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";

const PROGRAM_ID = new PublicKey("72bwK5ffBy2vRTu694L8WtQ6xaXYA8ePJtxB34fnV2wv");

function getSolVaultPDA(mint) {
  return PublicKey.findProgramAddressSync([Buffer.from("sol_vault"), mint.toBuffer()], PROGRAM_ID);
}

async function main() {
  const mintStr = process.argv[2];
  const amountSolStr = process.argv[3];
  if (!mintStr) {
    console.error("Usage: node scripts/topup-sol-vault.mjs <MINT_PUBKEY> [SOL_AMOUNT]");
    process.exit(1);
  }

  const mint = new PublicKey(mintStr);
  const [solVault] = getSolVaultPDA(mint);

  const rpc =
    process.env.SOLANA_RPC_URL ||
    "https://api.mainnet-beta.solana.com";
  const kpPath =
    process.env.KEYPAIR_PATH || path.join(os.homedir(), ".config/solana/id.json");
  const secret = JSON.parse(fs.readFileSync(kpPath, "utf8"));
  const payer = Keypair.fromSecretKey(Uint8Array.from(secret));
  const connection = new Connection(rpc, "confirmed");

  let lamports;
  if (amountSolStr != null && amountSolStr !== "") {
    const sol = Number(amountSolStr);
    if (!Number.isFinite(sol) || sol <= 0) {
      console.error("SOL_AMOUNT must be a positive number");
      process.exit(1);
    }
    lamports = Math.ceil(sol * LAMPORTS_PER_SOL);
  } else {
    lamports = await connection.getMinimumBalanceForRentExemption(0);
  }

  console.log("RPC:", rpc);
  console.log("Payer:", payer.publicKey.toBase58());
  console.log("Mint:", mint.toBase58());
  console.log("sol_vault:", solVault.toBase58());
  console.log("Lamports:", lamports, `(${(lamports / LAMPORTS_PER_SOL).toFixed(6)} SOL)`);

  const ix = SystemProgram.transfer({
    fromPubkey: payer.publicKey,
    toPubkey: solVault,
    lamports,
  });
  const tx = new Transaction().add(ix);
  const sig = await sendAndConfirmTransaction(connection, tx, [payer], {
    commitment: "confirmed",
  });
  console.log("Signature:", sig);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
