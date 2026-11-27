/**
 * Impact-aware max leverage from Omnipair pool SOL depth.
 * Thin pools (≤~1 SOL) clear ~1.2–1.3x; deeper pools open higher CF.
 * Protocol hard CF ≈ 0.85 → theoretical max ~6.67x; UI caps at 5x.
 */

export const PROTOCOL_MAX_LEVERAGE = 5;
export const MIN_LEVERAGE = 1;

/** Conservative CF used by sendOmnipairLeverageStepTx on thin pools. */
export function poolSafeCf(reserveSol: number): number {
  if (!(reserveSol > 0)) return 0.12;
  if (reserveSol < 0.75) return 0.22;
  if (reserveSol < 2) return 0.32;
  if (reserveSol < 5) return 0.45;
  if (reserveSol < 15) return 0.55;
  if (reserveSol < 40) return 0.65;
  return 0.75;
}

/** Max selectable leverage for this pool (1 / (1 − CF), capped). */
export function poolMaxLeverage(reserveSol: number): number {
  const cf = poolSafeCf(reserveSol);
  const raw = 1 / (1 - Math.min(0.84, cf));
  const capped = Math.min(PROTOCOL_MAX_LEVERAGE, Math.max(MIN_LEVERAGE, raw));
  // Snap to 0.1 so slider Max lands cleanly.
  return Math.round(capped * 10) / 10;
}

export function clampLeverage(lev: number, maxLev: number): number {
  const hi = Math.max(MIN_LEVERAGE, maxLev);
  if (!(lev > 0)) return MIN_LEVERAGE;
  return Math.min(hi, Math.max(MIN_LEVERAGE, Math.round(lev * 10) / 10));
}
