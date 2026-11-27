/**
 * Tales platform overlay fee (on top of Omnipair pool swap fee).
 * Charged only on txs built by this site — skimmed as SOL to the platform treasury.
 */
import { PublicKey, SystemProgram, type TransactionInstruction } from "@solana/web3.js";

/** 30 bps = 0.30% */
export const PLATFORM_FEE_BPS = 30;
export const PLATFORM_FEE_PCT_LABEL = "0.30%";

export function platformFeeRecipient(): PublicKey | null {
  const raw =
    process.env.NEXT_PUBLIC_PLATFORM_FEE_WALLET?.trim() ||
    process.env.NEXT_PUBLIC_PLATFORM_AUTHORITY?.trim() ||
    "";
  if (!raw) return null;
  try {
    return new PublicKey(raw);
  } catch {
    return null;
  }
}

/** Lamports skimmed from a SOL notional (UI SOL → lamports). */
export function platformFeeLamportsFromSol(solUi: number): bigint {
  if (!(solUi > 0) || !Number.isFinite(solUi)) return BigInt(0);
  const lamports = BigInt(Math.floor(solUi * 1e9));
  return (lamports * BigInt(PLATFORM_FEE_BPS)) / BigInt(10_000);
}

/** Net SOL UI after platform fee (what actually hits the pool / collateral). */
export function solAfterPlatformFee(solUi: number): {
  feeSol: number;
  netSol: number;
  feeLamports: bigint;
} {
  const feeLamports = platformFeeLamportsFromSol(solUi);
  const feeSol = Number(feeLamports) / 1e9;
  const netSol = Math.max(0, solUi - feeSol);
  return { feeSol, netSol, feeLamports };
}

/**
 * Optional SystemProgram transfer of the platform fee.
 * Returns null when fee is zero or treasury is unset (swap proceeds without overlay).
 */
export function buildPlatformFeeTransferIx(params: {
  from: PublicKey;
  solUi: number;
}): { ix: TransactionInstruction; feeLamports: bigint; feeSol: number } | null {
  const to = platformFeeRecipient();
  if (!to) return null;
  const feeLamports = platformFeeLamportsFromSol(params.solUi);
  if (feeLamports <= BigInt(0)) return null;
  if (to.equals(params.from)) return null;
  return {
    ix: SystemProgram.transfer({
      fromPubkey: params.from,
      toPubkey: to,
      lamports: Number(feeLamports),
    }),
    feeLamports,
    feeSol: Number(feeLamports) / 1e9,
  };
}
