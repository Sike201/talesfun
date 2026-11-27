import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

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

const SUBSCRIPT = "\u2080\u2081\u2082\u2083\u2084\u2085\u2086\u2087\u2088\u2089";

function toSubscriptDigits(n: number): string {
  return String(Math.max(0, Math.min(99, Math.floor(n))))
    .split("")
    .map(c => SUBSCRIPT[Number(c)] ?? c)
    .join("");
}

/**
 * USD token price with readable decimals (pump.fun-style zero-subscript for tiny values).
 * e.g. 0.000005236 → $0.00000524 · 1.22e-7 → $0₇122
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
    return `$${sign}${a.toLocaleString(undefined, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 6,
    })}`;
  }
  if (a >= 1e-4) {
    // Keep fixed decimals so "$0.000005" never becomes "$0.00".
    const s = a.toFixed(8).replace(/0+$/, "").replace(/\.$/, "");
    return `$${sign}${s}`;
  }

  const [mantStr, expPart] = a.toExponential().split("e");
  const exp = parseInt(expPart ?? "0", 10);
  const zeroCount = -exp - 1;
  if (!(zeroCount >= 3)) {
    const s = a.toFixed(12).replace(/0+$/, "").replace(/\.$/, "");
    return `$${sign}${s}`;
  }
  const sig = (mantStr ?? "0")
    .replace(".", "")
    .replace(/^0+/, "")
    .replace(/0+$/, "")
    .slice(0, 4);
  return `$${sign}0${toSubscriptDigits(zeroCount)}${sig || "0"}`;
}

/** SOL per 1 UI token (bonding / Omnipair spot). Never scientific notation. */
export function formatSolPerTokenPrice(solPerToken: number): string {
  if (!Number.isFinite(solPerToken) || solPerToken <= 0) return "—";
  const a = solPerToken;
  if (a >= 0.0001) {
    const s = a.toFixed(10).replace(/0+$/, "").replace(/\.$/, "");
    return `${s} SOL`;
  }
  if (a >= 1e-9) {
    const s = a.toFixed(14).replace(/0+$/, "").replace(/\.$/, "");
    return `${s} SOL`;
  }
  const [mantStr, expPart] = a.toExponential().split("e");
  const exp = parseInt(expPart ?? "0", 10);
  const zeroCount = -exp - 1;
  if (zeroCount >= 3) {
    const sig = (mantStr ?? "0")
      .replace(".", "")
      .replace(/^0+/, "")
      .replace(/0+$/, "")
      .slice(0, 4);
    return `0${toSubscriptDigits(zeroCount)}${sig || "0"} SOL`;
  }
  return `${a.toFixed(18).replace(/0+$/, "")} SOL`;
}

export function shortenAddress(address: string, chars = 4): string {
  return `${address.slice(0, chars)}...${address.slice(-chars)}`;
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
