import { Program, AnchorProvider, BN } from "@coral-xyz/anchor";
import { Connection, PublicKey } from "@solana/web3.js";
import type { AnchorWallet } from "@solana/wallet-adapter-react";
import idl from "./idl/higher_launchpad.json";
import { type Token, GRADUATION_SOL } from "@/types";

export const PROGRAM_ID = new PublicKey(
  process.env.NEXT_PUBLIC_PROGRAM_ID ||
    "72bwK5ffBy2vRTu694L8WtQ6xaXYA8ePJtxB34fnV2wv"
);

/** Must match `program/programs/higher-launchpad/src/lib.rs` `OMNIPAIR_PROGRAM_ID` and frontend env. */
export const OMNIPAIR_PROGRAM_ID_STR =
  process.env.NEXT_PUBLIC_OMNIPAIR_PROGRAM_ID ||
  process.env.OMNIPAIR_PROGRAM_ID ||
  "omnixgS8fnqHfCcTGKWj6JtKjzpJZ1Y5y9pyFkQDkYE";

export function hasRealOmnipairPoolOnChain(
  token: Pick<Token, "phase" | "gammPool">
): boolean {
  if (token.phase !== "graduated") return false;
  const p = token.gammPool?.trim();
  if (!p) return false;
  return p !== PublicKey.default.toBase58();
}

const METADATA_PROGRAM_ID = new PublicKey(
  "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s"
);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type HigherProgram = Program<any>;

export function getProgram(
  wallet: AnchorWallet,
  connection: Connection
): HigherProgram {
  const provider = new AnchorProvider(connection, wallet, {
    commitment: "confirmed",
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new Program(idl as any, provider);
}

export function getReadOnlyProgram(connection: Connection): HigherProgram {
  const dummyWallet = {
    publicKey: PublicKey.default,
    signTransaction: async <T,>(tx: T) => tx,
    signAllTransactions: async <T,>(txs: T[]) => txs,
  } as AnchorWallet;
  const provider = new AnchorProvider(connection, dummyWallet, {
    commitment: "confirmed",
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new Program(idl as any, provider);
}

// ── PDA helpers ──────────────────────────────────────────────────────────────

export function getPlatformPDA(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("platform")],
    PROGRAM_ID
  );
}

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

export function getMetadataPDA(mint: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("metadata"),
      METADATA_PROGRAM_ID.toBuffer(),
      mint.toBuffer(),
    ],
    METADATA_PROGRAM_ID
  );
  return pda;
}

// ── On-chain → frontend type conversion ──────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function tokenStateToToken(state: any, mintAddress: string): Token {
  const vSol = state.virtualSolReserve.toNumber();
  const vToken = state.virtualTokenReserve.toNumber();
  // price = (vSol / 1e9) / (vToken / 1e6)  →  SOL per 1 UI token
  const currentPrice = vToken > 0 ? vSol / (vToken * 1000) : 0;
  const solRaised = state.solRaised.toNumber() / 1e9;

  const phase: "bonding" | "graduated" = state.phase.graduated
    ? "graduated"
    : "bonding";

  const uri = typeof state.uri === "string" ? state.uri.trim() : "";

  return {
    id: mintAddress,
    mint: mintAddress,
    name: state.name,
    ticker: state.symbol,
    description: "",
    imageUrl: "",
    metadataUri: uri || undefined,
    creator: state.creator.toBase58(),
    creatorFeeRecipient: state.creatorFeeRecipient.toBase58(),
    createdAt: new Date(state.createdAt.toNumber() * 1000),
    phase,
    solRaised,
    targetSOL: GRADUATION_SOL,
    tokensSold: state.tokensSold.toNumber() / 1e6,
    totalSupply: state.totalSupply.toNumber() / 1e6,
    currentPrice,
    marketCap: currentPrice * (state.totalSupply.toNumber() / 1e6) * 140,
    launchPrice: 30_000_000_000 / (1_073_000_191_000_000 * 1000),
    funders: 0,
    gammPool: state.gammPool.toBase58() === PublicKey.default.toBase58()
      ? undefined
      : state.gammPool.toBase58(),
    creatorFeesEarned: state.creatorFeesAccumulated.toNumber() / 1e9,
  };
}

// ── Bonding curve math (mirrors the Rust) ────────────────────────────────────

export function calculateTokensOut(
  virtualSol: BN,
  virtualTokens: BN,
  solIn: BN
): BN {
  const k = virtualSol.mul(virtualTokens);
  const newSol = virtualSol.add(solIn);
  const newTokens = k.div(newSol);
  return virtualTokens.sub(newTokens);
}

export function calculateSolOut(
  virtualSol: BN,
  virtualTokens: BN,
  tokensIn: BN
): BN {
  const k = virtualSol.mul(virtualTokens);
  const newTokens = virtualTokens.add(tokensIn);
  const newSol = k.div(newTokens);
  return virtualSol.sub(newSol);
}
