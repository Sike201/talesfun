import { BN } from "@coral-xyz/anchor";
import { CREATOR_FEE_BPS } from "@/types";
import type { Token } from "@/types";
import { calculateTokensOut, calculateSolOut } from "@/lib/program";
import { calcBondingCurveProgress } from "@/lib/utils";

const BPS = new BN(10_000);

/** ~1M SOL — rejects absurd UI input before lamport math. */
const MAX_SOL_UI_FOR_QUOTE = 1_000_000;

/**
 * Converts gross SOL (UI) → lamports string for `BN`, or `null` if invalid / unsafe.
 * Prevents `new BN(NaN)` / non-integer assertions from bn.js.
 */
export function lamportsFromSolUiSafe(grossSolUi: number): string | null {
  if (!Number.isFinite(grossSolUi) || grossSolUi <= 0 || grossSolUi > MAX_SOL_UI_FOR_QUOTE) {
    return null;
  }
  const lam = Math.floor(grossSolUi * 1e9);
  if (!Number.isSafeInteger(lam) || lam <= 0) {
    return null;
  }
  return lam.toString();
}

function tryBnFromUnsignedDecimalString(s: string): BN | null {
  const t = s.trim();
  if (!t || !/^\d+$/.test(t)) return null;
  try {
    const b = new BN(t, 10);
    return b;
  } catch {
    return null;
  }
}

export type BondingBuyQuote = {
  grossSolUi: number;
  grossLamports: BN;
  creatorFeeLamports: BN;
  netLamports: BN;
  tokensOutUncappedRaw: BN;
  tokensOutCappedRaw: BN;
  saturated: boolean;
  /** Gross SOL actually sent on-chain (≤ user input; capped when bonding inventory would be exceeded). */
  effectiveGrossLamports: BN;
};

export function grossBuyToNetLamports(gross: BN): { fee: BN; net: BN } {
  const fee = gross.mul(new BN(CREATOR_FEE_BPS)).div(BPS);
  const net = gross.sub(fee);
  return { fee, net };
}

/**
 * Max gross lamports ∈ [0, desiredGross] such that constant-product tokens out ≤ real token remaining.
 */
export function maxBuyGrossLamportsWithinInventory(
  desiredGross: BN,
  virtualSol: BN,
  virtualToken: BN,
  realTokenRemaining: BN
): BN {
  if (desiredGross.lte(new BN(0))) return new BN(0);
  const { net: n0 } = grossBuyToNetLamports(desiredGross);
  const t0 = calculateTokensOut(virtualSol, virtualToken, n0);
  if (t0.lte(realTokenRemaining)) return desiredGross;

  let lo = new BN(0);
  let hi = desiredGross;
  while (hi.sub(lo).gt(new BN(1))) {
    const mid = lo.add(hi).div(new BN(2));
    const { net } = grossBuyToNetLamports(mid);
    const tok = calculateTokensOut(virtualSol, virtualToken, net);
    if (tok.gt(realTokenRemaining)) hi = mid;
    else lo = mid;
  }
  return lo;
}

/** Exact launchpad buy path: creator fee off gross, then CP; clamp tokens to remaining bonding inventory. */
export function quoteBondingBuy(
  grossSolUi: number,
  virtualSolLamports: string,
  virtualTokenRaw: string,
  realTokenRemainingRaw: string
): BondingBuyQuote | null {
  const lamStr = lamportsFromSolUiSafe(grossSolUi);
  if (lamStr == null) return null;
  const grossLamports = tryBnFromUnsignedDecimalString(lamStr);
  if (grossLamports == null || grossLamports.lte(new BN(0))) return null;

  const vSol = tryBnFromUnsignedDecimalString(virtualSolLamports);
  const vTok = tryBnFromUnsignedDecimalString(virtualTokenRaw);
  const realRem = tryBnFromUnsignedDecimalString(realTokenRemainingRaw);
  if (vSol == null || vTok == null || realRem == null) return null;
  if (vSol.lte(new BN(0)) || vTok.lte(new BN(0))) return null;

  const { fee: dispFee, net: dispNet } = grossBuyToNetLamports(grossLamports);
  const tokensAtFull = calculateTokensOut(vSol, vTok, dispNet);
  const saturated = tokensAtFull.gt(realRem);
  const tokensCapped = BN.min(tokensAtFull, realRem);
  const effectiveGross = saturated
    ? maxBuyGrossLamportsWithinInventory(grossLamports, vSol, vTok, realRem)
    : grossLamports;

  return {
    grossSolUi,
    grossLamports,
    creatorFeeLamports: dispFee,
    netLamports: dispNet,
    tokensOutUncappedRaw: tokensAtFull,
    tokensOutCappedRaw: tokensCapped,
    saturated,
    effectiveGrossLamports: effectiveGross,
  };
}

/** Max token raw units (6 decimals) for quote — avoids pathological BN sizes. */
const MAX_TOKEN_RAW_STR_LEN = 24;

export function quoteBondingSellSolUi(
  tokenRawBn: BN,
  virtualSolLamports: string,
  virtualTokenRaw: string,
  realSolRemainingLamports: string
): { solOutRaw: BN; capped: boolean } | null {
  if (tokenRawBn.lte(new BN(0))) return null;
  const tr = tokenRawBn.toString();
  if (tr.length > MAX_TOKEN_RAW_STR_LEN) return null;
  const vSol = tryBnFromUnsignedDecimalString(virtualSolLamports);
  const vTok = tryBnFromUnsignedDecimalString(virtualTokenRaw);
  const realSol = tryBnFromUnsignedDecimalString(realSolRemainingLamports);
  if (vSol == null || vTok == null || realSol == null) return null;
  if (vSol.lte(new BN(0)) || vTok.lte(new BN(0))) return null;
  const solOut = calculateSolOut(vSol, vTok, tokenRawBn);
  if (solOut.lte(realSol)) return { solOutRaw: solOut, capped: false };
  return { solOutRaw: realSol, capped: true };
}

export function logBondingQuoteDebug(
  label: string,
  q: BondingBuyQuote,
  token: Pick<
    Token,
    | "ticker"
    | "chainVirtualSolLamports"
    | "chainVirtualTokenReserveRaw"
    | "chainRealTokenReserveRaw"
    | "currentPrice"
    | "marketCap"
    | "solRaised"
    | "targetSOL"
  >,
  solUsd: number | null | undefined
): void {
  if (process.env.NEXT_PUBLIC_DEBUG_BONDING_UI !== "1") return;
  const rem = token.chainRealTokenReserveRaw ?? "0";
  const remUi = Number(rem) / 1e6;
  const outUi = Number(q.tokensOutCappedRaw.toString()) / 1e6;
  const progress = calcBondingCurveProgress(token.solRaised, token.targetSOL);
  console.log(`[higher:bonding-ui] ${label}`, {
    gross_sol_input: q.grossSolUi,
    creator_fee_lamports: q.creatorFeeLamports.toString(),
    net_lamports_quoted_from_input: q.netLamports.toString(),
    virtual_sol_lamports: token.chainVirtualSolLamports,
    virtual_token_raw: token.chainVirtualTokenReserveRaw,
    quoted_tokens_out_raw_uncapped: q.tokensOutUncappedRaw.toString(),
    quoted_tokens_out_ui_capped: outUi,
    remaining_bonding_tokens_ui: remUi,
    effective_gross_lamports_for_tx: q.effectiveGrossLamports.toString(),
    saturated_vs_full_input: q.saturated,
    displayed_spot_sol_per_token: token.currentPrice,
    displayed_market_cap_usd: token.marketCap,
    sol_usd_oracle: solUsd ?? null,
    graduation_progress_pct: progress,
  });
}

export function logBondingPanelDebug(
  token: Pick<
    Token,
    | "mint"
    | "ticker"
    | "currentPrice"
    | "marketCap"
    | "totalSupply"
    | "solRaised"
    | "targetSOL"
    | "chainVirtualSolLamports"
    | "chainVirtualTokenReserveRaw"
    | "chainRealTokenReserveRaw"
    | "chainRealSolReserveLamports"
  >,
  solUsd: number | null | undefined
): void {
  if (process.env.NEXT_PUBLIC_DEBUG_BONDING_UI !== "1") return;
  const progress = calcBondingCurveProgress(token.solRaised, token.targetSOL);
  const mcap =
    Number.isFinite(token.currentPrice) &&
    token.currentPrice > 0 &&
    Number.isFinite(token.totalSupply)
      ? token.currentPrice * token.totalSupply * (solUsd ?? 140)
      : 0;
  console.log("[higher:bonding-ui] stats panel", {
    mint: token.mint?.slice(0, 8) + "…",
    spot_sol_per_token: token.currentPrice,
    market_cap_usd_token_field: token.marketCap,
    market_cap_usd_recomputed: mcap,
    sol_raised_sol: token.solRaised,
    target_sol: token.targetSOL,
    graduation_progress_pct: progress,
    virtual_sol_lamports: token.chainVirtualSolLamports,
    virtual_token_raw: token.chainVirtualTokenReserveRaw,
    real_token_remaining_raw: token.chainRealTokenReserveRaw,
    real_sol_lamports: token.chainRealSolReserveLamports,
    sol_usd_oracle: solUsd ?? null,
  });
}
