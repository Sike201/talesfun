/**
 * Omnipair-style portfolio metrics: LTV, distance-to-liquidation, liq price, PnL.
 */
import type { PublicKey } from "@solana/web3.js";
import { NATIVE_MINT } from "@solana/spl-token";
import type { OmnipairUserPositionView } from "./omnipairLending";
import type { OpenLeveragePosition } from "./openPositions";
import { markPositionValueUsd } from "./openPositions";

export type PositionRisk = {
  /** Current loan-to-value 0–1 */
  ltv: number;
  /** Liquidation CF 0–1 (from position lock or fallback) */
  liquidationLtv: number;
  /**
   * Remaining headroom to liquidation (Omnipair “To liquidation”).
   * 100% = no debt; ~0% = about to liquidate.
   */
  toLiquidationPct: number;
  /** Approximate liquidation spot (SOL per project token) */
  liquidationSpotSol: number | null;
  collateralUsd: number;
  debtUsd: number;
  riskLabel: "Low risk" | "Medium risk" | "High risk";
};

function bnUi(raw: bigint, decimals: number): number {
  return Number(raw) / 10 ** decimals;
}

/**
 * Build risk metrics from on-chain user position + live spot.
 * Long/borrow: project collateral, SOL debt.
 * Short: SOL collateral, project debt.
 */
export function riskFromOnChainPosition(params: {
  pos: OmnipairUserPositionView;
  projectMint: PublicKey;
  projectDecimals: number;
  spotSol: number;
  solUsd: number;
  /** Fallback when position CF unset — Omnipair default liq ~85% */
  fallbackLiqLtv?: number;
}): PositionRisk {
  const {
    pos,
    projectMint,
    projectDecimals,
    spotSol,
    solUsd,
    fallbackLiqLtv = 0.85,
  } = params;

  const projectIs0 = pos.token0.equals(projectMint);
  const collProject = bnUi(
    projectIs0 ? pos.collateral0 : pos.collateral1,
    projectDecimals
  );
  const collSol = bnUi(
    NATIVE_MINT.equals(pos.token0) ? pos.collateral0 : pos.collateral1,
    9
  );
  const debtSol = bnUi(
    NATIVE_MINT.equals(pos.token0) ? pos.debt0Raw : pos.debt1Raw,
    9
  );
  const debtProject = bnUi(
    projectIs0 ? pos.debt0Raw : pos.debt1Raw,
    projectDecimals
  );

  const isShort = debtProject > 0 || (collSol > 0 && debtSol <= 0 && collProject <= 0);

  // Use locked liquidation CF from the position when present (Omnipair stores bps per side).
  const lockedBps = isShort
    ? // Short: SOL collateral backs project debt
      NATIVE_MINT.equals(pos.token0)
        ? pos.collateral0LiquidationCfBps
        : pos.collateral1LiquidationCfBps
    : projectIs0
      ? pos.collateral0LiquidationCfBps
      : pos.collateral1LiquidationCfBps;
  const liquidationLtv =
    lockedBps > 0 ? Math.min(1, lockedBps / 10_000) : fallbackLiqLtv;

  let collateralUsd = 0;
  let debtUsd = 0;
  let ltv = 0;
  let liquidationSpotSol: number | null = null;

  if (isShort) {
    collateralUsd = collSol * solUsd;
    debtUsd = debtProject * spotSol * solUsd;
    ltv =
      collateralUsd > 0 ? Math.min(1.5, debtUsd / collateralUsd) : debtUsd > 0 ? 1 : 0;
    if (debtProject > 0 && liquidationLtv > 0) {
      // Liquidates when debt_tokens * spot = coll_sol * liqCF
      liquidationSpotSol = (collSol * liquidationLtv) / debtProject;
    }
  } else {
    collateralUsd = collProject * spotSol * solUsd;
    debtUsd = debtSol * solUsd;
    ltv =
      collateralUsd > 0 ? Math.min(1.5, debtUsd / collateralUsd) : debtUsd > 0 ? 1 : 0;
    if (collProject > 0 && liquidationLtv > 0) {
      // Liquidates when debt_sol = coll_tokens * spot * liqCF
      liquidationSpotSol = debtSol / (collProject * liquidationLtv);
    }
  }

  const toLiquidationPct =
    liquidationLtv > 0
      ? Math.max(0, Math.min(100, (1 - ltv / liquidationLtv) * 100))
      : 100;

  const riskLabel: PositionRisk["riskLabel"] =
    toLiquidationPct < 15
      ? "High risk"
      : toLiquidationPct < 40
        ? "Medium risk"
        : "Low risk";

  return {
    ltv,
    liquidationLtv,
    toLiquidationPct,
    liquidationSpotSol,
    collateralUsd,
    debtUsd,
    riskLabel,
  };
}

export function tradePnlUsd(
  pos: OpenLeveragePosition,
  spotSol: number
): { entryUsd: number; markUsd: number; pnlUsd: number; pnlPct: number } {
  const { entryUsd, markUsd } = markPositionValueUsd(pos, spotSol);
  const pnlUsd = markUsd - entryUsd;
  const pnlPct = entryUsd > 0 ? (pnlUsd / entryUsd) * 100 : 0;
  return { entryUsd, markUsd, pnlUsd, pnlPct };
}

/** Exposure ≈ margin × leverage in USD (entry). */
export function tradeExposureUsd(pos: OpenLeveragePosition): number {
  if (!(pos.leverage > 0) || !(pos.entrySolUsd > 0)) return 0;
  if (pos.direction === "long") {
    return pos.marginUi * pos.entrySpotSol * pos.entrySolUsd * pos.leverage;
  }
  return pos.marginUi * pos.entrySolUsd * pos.leverage;
}
