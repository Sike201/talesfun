import { PublicKey } from "@solana/web3.js";
import {
  PROGRAM_ID as OMNIPAIR_PACKAGE_DEFAULT,
  SEEDS,
} from "@omnipair/program-interface";

/**
 * Omnipair program used for PDA derivation, IDL `address`, and CPI alignment with * `higher_launchpad::OMNIPAIR_PROGRAM_ID`.
 *
 * Set `NEXT_PUBLIC_OMNIPAIR_PROGRAM_ID` for browser bundles; `OMNIPAIR_PROGRAM_ID` also works in Node.
 * Falls back to the official id from `@omnipair/program-interface` when unset.
 */
function readOmnipairProgramIdString(): string {
  if (typeof process === "undefined" || !process.env) {
    return OMNIPAIR_PACKAGE_DEFAULT.toBase58();
  }
  return (
    process.env.NEXT_PUBLIC_OMNIPAIR_PROGRAM_ID ||
    process.env.OMNIPAIR_PROGRAM_ID ||
    OMNIPAIR_PACKAGE_DEFAULT.toBase58()
  );
}

export const OMNIPAIR_PROGRAM_ID = new PublicKey(readOmnipairProgramIdString());

export const OMNIPAIR_PROGRAM_ID_STR = OMNIPAIR_PROGRAM_ID.toBase58();

function paramsHashBytes(paramsHash: number[] | Uint8Array | Buffer): Buffer {
  const buf = Buffer.from(paramsHash);
  if (buf.length !== 32) {
    throw new Error(`paramsHash must be 32 bytes, got ${buf.length}`);
  }
  return buf;
}

export function deriveOmnipairPair(
  token0: PublicKey,
  token1: PublicKey,
  paramsHash: number[] | Uint8Array | Buffer,
  programId: PublicKey = OMNIPAIR_PROGRAM_ID
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [
      SEEDS.PAIR,
      token0.toBuffer(),
      token1.toBuffer(),
      paramsHashBytes(paramsHash),
    ],
    programId
  );
}

export function deriveOmnipairFutarchyAuthority(
  programId: PublicKey = OMNIPAIR_PROGRAM_ID
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([SEEDS.FUTARCHY_AUTHORITY], programId);
}

export function deriveOmnipairReserveVault(
  pair: PublicKey,
  reserveMint: PublicKey,
  programId: PublicKey = OMNIPAIR_PROGRAM_ID
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [SEEDS.RESERVE_VAULT, pair.toBuffer(), reserveMint.toBuffer()],
    programId
  );
}

export function deriveOmnipairCollateralVault(
  pair: PublicKey,
  collateralMint: PublicKey,
  programId: PublicKey = OMNIPAIR_PROGRAM_ID
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [SEEDS.COLLATERAL_VAULT, pair.toBuffer(), collateralMint.toBuffer()],
    programId
  );
}

export function omnipairEventAuthorityPda(
  programId: PublicKey = OMNIPAIR_PROGRAM_ID
): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("__event_authority")],
    programId
  );
  return pda;
}
