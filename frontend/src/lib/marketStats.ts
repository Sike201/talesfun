/**
 * Pump.fun–style market stats.
 *
 * Market cap = spot × **current mint supply** (post-burn) × SOL/USD
 * Liquidity (AMM TVL proxy) = 2 × SOL reserve × SOL/USD
 *   (at mid, both sides are equal → 2× quote matches total reserve value)
 */

export function marketCapUsdFromSpot(params: {
  spotSol: number;
  totalSupply: number;
  solUsd: number;
}): number {
  const { spotSol, totalSupply, solUsd } = params;
  if (!(spotSol > 0) || !(totalSupply > 0) || !(solUsd > 0)) return 0;
  return spotSol * totalSupply * solUsd;
}

/** Graduated Omnipair / Raydium-style liquidity strip. */
export function graduatedLiquidityUsd(params: {
  reserveSol: number;
  solUsd: number;
}): number {
  const { reserveSol, solUsd } = params;
  if (!(reserveSol > 0) || !(solUsd > 0)) return 0;
  return 2 * reserveSol * solUsd;
}

/**
 * Bonding-curve liquidity proxy (pump-like): treat raised SOL as the quote side
 * of a virtual AMM → 2× raised.
 */
export function bondingLiquidityUsd(params: {
  solRaised: number;
  solUsd: number;
}): number {
  const { solRaised, solUsd } = params;
  if (!(solRaised > 0) || !(solUsd > 0)) return 0;
  return 2 * solRaised * solUsd;
}

/**
 * How “thin” the book is vs mcap. Pump graduation is often ~4–8×;
 * thin Omnipair seeds can land much higher until depth grows.
 */
export function mcapToLiquidityRatio(mcapUsd: number, liqUsd: number): number | null {
  if (!(mcapUsd > 0) || !(liqUsd > 0)) return null;
  return mcapUsd / liqUsd;
}

/** True when liquidity is under 1% of market cap (pump-style “thin pool” signal). */
export function isThinLiquidity(mcapUsd: number, liqUsd: number): boolean {
  if (!(mcapUsd > 0) || !(liqUsd > 0)) return false;
  return liqUsd / mcapUsd < 0.01;
}
