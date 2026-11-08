/**
 * One-time devnet/mainnet: create an empty Address Lookup Table for Omnipair bootstrap v0 txs.
 * Your wallet becomes the ALT authority (required for auto-extend in `sendBootstrapOmnipairPoolTx`).
 *
 * From `frontend/` (keypair must match the wallet you connect in Phantom for bootstrap):
 *   RPC_URL=https://api.devnet.solana.com \
 *   WALLET_KEYPAIR=$HOME/.config/solana/id.json \
 *   npx --yes tsx scripts/create-omnipair-bootstrap-alt.ts
 *
 * Add printed line to `.env.local`:
 *   NEXT_PUBLIC_OMNIPAIR_BOOTSTRAP_ALT=<address>
 */
import fs from "fs";
import path from "path";
import {
  AddressLookupTableProgram,
  Connection,
  Keypair,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";

function loadWalletKp(): Keypair {
  const kp =
    process.env.WALLET_KEYPAIR ||
    path.join(process.env.HOME || "", ".config/solana/id.json");
  const secret = JSON.parse(fs.readFileSync(kp, "utf8")) as number[];
  return Keypair.fromSecretKey(Uint8Array.from(secret));
}

async function main() {
  const rpc =
    process.env.RPC_URL ||
    process.env.SOLANA_RPC_URL ||
    "https://api.devnet.solana.com";
  const connection = new Connection(rpc, "confirmed");
  const payer = loadWalletKp();

  const slot = await connection.getSlot("finalized");
  const [createIx, lookupTableAddress] =
    AddressLookupTableProgram.createLookupTable({
      authority: payer.publicKey,
      payer: payer.publicKey,
      recentSlot: slot - 1,
    });

  const tx = new Transaction().add(createIx);

  const sig = await sendAndConfirmTransaction(connection, tx, [payer], {
    commitment: "confirmed",
  });

  const altInfo = await connection.getAddressLookupTable(lookupTableAddress, {
    commitment: "confirmed",
  });
  const authorityOnChain = altInfo.value?.state.authority?.toBase58() ?? "(missing)";

  console.log("");
  console.log("=== Omnipair bootstrap ALT (save these) ===");
  console.log("RPC:", rpc);
  console.log("Create tx:", sig);
  console.log("ALT address:     ", lookupTableAddress.toBase58());
  console.log("ALT authority:   ", payer.publicKey.toBase58());
  console.log("Authority (chain):", authorityOnChain);
  console.log("");
  console.log(
    "The browser wallet that extends this ALT must be THIS authority pubkey.",
    "If you use Phantom, connect the wallet whose keypair you used as WALLET_KEYPAIR (default ~/.config/solana/id.json)."
  );
  console.log("");
  console.log("Add to frontend/.env.local:");
  console.log(`NEXT_PUBLIC_OMNIPAIR_BOOTSTRAP_ALT=${lookupTableAddress.toBase58()}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
