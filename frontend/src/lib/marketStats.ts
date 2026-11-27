/**
 * Pump.fun / stonk.fun–style market stats.
 *
 * Market cap (FDV) = spot × total supply × SOL/USD
 * Liquidity (AMM TVL proxy) = 2 × SOL reserve × SOL/USD
 *   (balanced pool: token side ≈ SOL side, so 2× quote is the usual launchpad display)
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
 * How “thin” the book is vs FDV. Pump graduation is often ~4–8×;
 * thin Omnipair seeds can land 50–200× until depth grows.
 */
export function mcapToLiquidityRatio(mcapUsd: number, liqUsd: number): number | null {
  if (!(mcapUsd > 0) || !(liqUsd > 0)) return null;
  return mcapUsd / liqUsd;
}
