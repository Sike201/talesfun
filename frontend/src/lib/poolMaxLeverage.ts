/**
 * Impact-aware max leverage / margin from Omnipair docs:
 * https://docs.omnipair.fi/use-cases/leveraging
 * https://docs.omnipair.fi/technical-breakdown/slippage-aware-collateral-factor
 *
 * Constraints (always, including ~1x):
 * - Max lev ≈ 1/(1−CF); CF collapses with size vs AMM reserves (impact)
 * - Available cash in the pool caps what can be borrowed
 * - Shorts borrow the project token — cannot exceed cash reserve
 * - Large collateral vs reserve has steep liquidation impact (docs table:
 *   10% of reserve ≈ −9%, 50% ≈ −33%) so UI keeps collateral in a low-impact band
 */

export const PROTOCOL_MAX_LEVERAGE = 5;
export const MIN_LEVERAGE = 1;

/** Fraction of cash reserve we allow a single open to borrow against. */
export const BORROW_CASH_FRAC = 0.12;
/** Cap collateral vs that side's reserve so impact CF stays usable. */
export const IMPACT_COLLATERAL_FRAC = 0.12;

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
  return Math.round(capped * 10) / 10;
}

export function clampLeverage(lev: number, maxLev: number): number {
  const hi = Math.max(MIN_LEVERAGE, maxLev);
  if (!(lev > 0)) return MIN_LEVERAGE;
  return Math.min(hi, Math.max(MIN_LEVERAGE, Math.round(lev * 10) / 10));
}

export type PoolMarginCapsInput = {
  direction: "long" | "short";
  leverage: number;
  spotSol: number;
  reserveSol: number;
  /** Project-token reserve in UI units */
  reserveProjectUi: number;
  walletTokens: number;
  walletSol: number;
};

/**
 * Max margin the UI should offer — min(wallet, impact collateral band, borrow liquidity).
 * At 1.0x there is no borrow loop; collateral is still capped vs reserves (Omnipair
 * impact CF / liquidation through the AMM). Shorts especially cannot size past pool cash.
 */
export function poolMaxMarginUi(input: PoolMarginCapsInput): {
  maxMargin: number;
  safeCf: number;
  borrowFraction: number;
  reason: string;
} {
  const {
    direction,
    leverage,
    spotSol,
    reserveSol,
    reserveProjectUi,
    walletTokens,
    walletSol,
  } = input;

  const safeCf = poolSafeCf(reserveSol);
  const lev = Math.max(MIN_LEVERAGE, leverage);
  const borrowFraction = Math.max(0, lev - 1) / lev;
  const isOneX = borrowFraction < 1e-8;

  if (direction === "long") {
    const walletCap = walletTokens > 0 ? walletTokens * 0.98 : 0;
    const impactCap =
      reserveProjectUi > 0 ? reserveProjectUi * IMPACT_COLLATERAL_FRAC : walletCap;
    if (isOneX) {
      // Collateral-only: still pool-capped (docs — large collateral vs reserve = bad impact).
      const maxMargin = Math.min(walletCap, impactCap);
      return {
        maxMargin,
        safeCf,
        borrowFraction,
        reason: "1.0x collateral only · capped vs token reserve (impact CF)",
      };
    }
    const bf = Math.min(borrowFraction, safeCf);
    const maxBorrowSol = Math.max(0, reserveSol * BORROW_CASH_FRAC);
    const fromBorrow =
      spotSol > 0 && bf > 0 ? maxBorrowSol / (spotSol * bf * 0.9) : 0;
    const maxMargin = Math.min(walletCap, impactCap, fromBorrow);
    return {
      maxMargin,
      safeCf,
      borrowFraction,
      reason: "min(wallet, reserve impact, SOL borrow liquidity)",
    };
  }

  // Short: collateral SOL, borrow project tokens from cash reserve, sell into pool.
  const walletCap = Math.max(0, walletSol - 0.02);
  const impactCap = reserveSol > 0 ? reserveSol * IMPACT_COLLATERAL_FRAC : walletCap;
  const shortCf = Math.min(safeCf, 0.14);
  if (isOneX) {
    const maxMargin = Math.min(walletCap, impactCap);
    return {
      maxMargin,
      safeCf,
      borrowFraction,
      reason: "1.0x collateral only · capped vs SOL reserve (no short borrow yet)",
    };
  }
  const bf = Math.min(borrowFraction, shortCf);
  const maxBorrowTokens =
    reserveProjectUi > 0 ? reserveProjectUi * BORROW_CASH_FRAC : 0;
  const fromBorrow =
    spotSol > 0 && bf > 0 ? (maxBorrowTokens * spotSol) / (bf * 0.85) : 0;
  const maxMargin = Math.min(walletCap, impactCap, fromBorrow);
  return {
    maxMargin,
    safeCf,
    borrowFraction,
    reason: "min(wallet, SOL reserve impact, project-token borrow liquidity)",
  };
}
