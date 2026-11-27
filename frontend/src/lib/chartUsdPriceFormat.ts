/**
 * Chart / header USD prices — plain decimal points only (no zero-subscript, no scientific).
 * e.g. 0.000002468 → $0.000002468
 */

function formatFixedDecimals(value: number, minFrac = 2, maxFrac = 12): string {
  const a = Math.abs(value);
  if (!(a > 0)) return (0).toFixed(minFrac);
  const digits = Math.min(
    maxFrac,
    Math.max(minFrac, Math.ceil(-Math.log10(a)) + 3)
  );
  return a.toFixed(digits).replace(/0+$/, "").replace(/\.$/, "") || a.toFixed(minFrac);
}

/** Axis + crosshair + chart headline USD labels. */
export function formatUsdPumpChart(usd: number): string {
  if (!Number.isFinite(usd)) return "—";
  const sign = usd < 0 ? "-" : "";
  const a = Math.abs(usd);
  if (a === 0) return "$0.00";

  if (a >= 1) {
    return `$${sign}${a.toLocaleString(undefined, {
      minimumFractionDigits: 0,
      maximumFractionDigits: 2,
    })}`;
  }
  if (a >= 0.01) {
    return `$${sign}${formatFixedDecimals(a, 2, 6)}`;
  }
  return `$${sign}${formatFixedDecimals(a, 4, 12)}`;
}
