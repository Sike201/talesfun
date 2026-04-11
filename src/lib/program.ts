import { Program, AnchorProvider } from "@coral-xyz/anchor";
import { Connection, PublicKey } from "@solana/web3.js";
import type { AnchorWallet } from "@solana/wallet-adapter-react";
import type { HigherLaunchpad } from "./idl/higher_launchpad";
import idl from "./idl/higher_launchpad.json";

const PROGRAM_ID = new PublicKey(
  process.env.NEXT_PUBLIC_PROGRAM_ID ||
    "DYJsBMJEnDrU2ZL825wpu95CYHTY1zv875TvFfz64sBo"
);

export function getProgram(
  wallet: AnchorWallet,
  connection: Connection
): Program<HigherLaunchpad> {
  const provider = new AnchorProvider(connection, wallet, {
    commitment: "confirmed",
  });
  return new Program(idl as unknown as HigherLaunchpad, provider);
}

export { PROGRAM_ID };

// PDA derivation helpers
export function getTokenStatePDA(mint: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("token_state"), mint.toBuffer()],
    PROGRAM_ID
  );
}

export function getSolVaultPDA(mint: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("sol_vault"), mint.toBuffer()],
    PROGRAM_ID
  );
}

export function getMintAuthorityPDA(mint: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("mint_authority"), mint.toBuffer()],
    PROGRAM_ID
  );
}

export function getFeeEscrowPDA(mint: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("fee_escrow"), mint.toBuffer()],
    PROGRAM_ID
  );
}

export function getPlatformPDA(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("platform")],
    PROGRAM_ID
  );
}
