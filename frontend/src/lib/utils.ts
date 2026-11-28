import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";
import { PublicKey } from "@solana/web3.js";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toLocaleString();
}

export function formatSOL(lamports: number): string {
  return (lamports / 1e9).toFixed(4);
}

export function formatUSD(amount: number): string {
  if (!Number.isFinite(amount)) return "$—";
  const abs = Math.abs(amount);
  if (abs >= 1_000_000) return `$${(amount / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `$${(amount / 1_000).toFixed(1)}K`;
  // Micro token prices need visible decimals — never collapse to $0.00 / scientific.
  if (abs > 0 && abs < 0.01) return formatTokenPriceUsd(amount);
  return `$${amount.toFixed(2)}`;
}

/** Enough fixed decimals to show real digits — always with a decimal point, never subscript/scientific. */
function formatFixedDecimals(value: number, minFrac = 2, maxFrac = 12): string {
  const a = Math.abs(value);
  if (!(a > 0)) return (0).toFixed(minFrac);
  const digits = Math.min(
    maxFrac,
    Math.max(minFrac, Math.ceil(-Math.log10(a)) + 3)
  );
  return a.toFixed(digits).replace(/0+$/, "").replace(/\.$/, "") || a.toFixed(minFrac);
}

/**
 * USD token price with plain decimal points.
 * e.g. 0.000002735 → $0.000002735
 */
export function formatTokenPriceUsd(usd: number): string {
  if (!Number.isFinite(usd)) return "$—";
  if (usd === 0) return "$0.00";
  const sign = usd < 0 ? "-" : "";
  const a = Math.abs(usd);

  if (a >= 1) {
    return `$${sign}${a.toLocaleString(undefined, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 4,
    })}`;
  }
  if (a >= 0.01) {
    return `$${sign}${formatFixedDecimals(a, 2, 6)}`;
  }
  return `$${sign}${formatFixedDecimals(a, 4, 12)}`;
}

/** SOL per 1 UI token (bonding / Omnipair spot). Plain decimals only. */
export function formatSolPerTokenPrice(solPerToken: number): string {
  if (!Number.isFinite(solPerToken) || solPerToken <= 0) return "—";
  return `${formatFixedDecimals(solPerToken, 4, 14)} SOL`;
}

export function shortenAddress(address: string, chars = 4): string {
  return `${address.slice(0, chars)}...${address.slice(-chars)}`;
}

/** True when `value` is a plausible base58 Solana pubkey (mint / wallet). */
export function isSolanaAddress(value: string): boolean {
  const s = value.trim();
  if (s.length < 32 || s.length > 44) return false;
  if (!/^[1-9A-HJ-NP-Za-km-z]+$/.test(s)) return false;
  try {
    // Throws if decode fails or byte length ≠ 32
    // eslint-disable-next-line no-new
    new PublicKey(s);
    return true;
  } catch {
    return false;
  }
}

export function calcBondingCurveProgress(currentSOL: number, targetSOL: number): number {
  return Math.min((currentSOL / targetSOL) * 100, 100);
}

/** Simple constant-product price from bonding curve reserves */
export function calcTokenPrice(solReserve: number, tokenReserve: number): number {
  if (tokenReserve === 0) return 0;
  return solReserve / tokenReserve;
}

export function timeAgo(date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/** Longer relative age for pool / pair rows (e.g. `9mo 8d ago`). */
export function formatPairAge(date: Date): string {
  const ms = Date.now() - date.getTime();
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  const remDays = days - months * 30;
  if (months < 12) {
    return remDays > 0 ? `${months}mo ${remDays}d ago` : `${months}mo ago`;
  }
  const years = Math.floor(months / 12);
  const remMonths = months - years * 12;
  return remMonths > 0 ? `${years}y ${remMonths}mo ago` : `${years}y ago`;
}

/**
 * SOL per token from raw lamports and token base units (6 decimals).
 * Use instead of BN.toNumber() ratios so large trades never yield NaN/Infinity.
 */
export function priceSolFromRawDecimals(
  solLamportsRaw: string,
  tokenRaw: string,
  tokenDecimals: number
): number {
  try {
    const sol = BigInt(solLamportsRaw || "0");
    const tok = BigInt(tokenRaw || "0");
    if (tok === BigInt(0)) return 0;
    const d = Math.min(18, Math.max(0, Math.floor(tokenDecimals)));
    const tokUi = Number(tok) / 10 ** d;
    const solUi = Number(sol) / 1e9;
    if (!Number.isFinite(tokUi) || !Number.isFinite(solUi) || tokUi === 0) return 0;
    return solUi / tokUi;
  } catch {
    return 0;
  }
}

export function priceSolFromRaw(solLamportsRaw: string, tokenRaw: string): number {
  try {
    const sol = BigInt(solLamportsRaw || "0");
    const tok = BigInt(tokenRaw || "0");
    if (tok === BigInt(0)) return 0;
    const num = sol * BigInt(1_000_000);
    const den = tok * BigInt(1_000_000_000);
    const n = Number(num);
    const d = Number(den);
    if (!Number.isFinite(n) || !Number.isFinite(d) || d === 0) return 0;
    return n / d;
  } catch {
    return 0;
  }
}
