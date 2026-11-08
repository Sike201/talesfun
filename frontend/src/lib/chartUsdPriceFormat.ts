/**
 * Pump.fun-style USD labels: `$` prefix; tiny prices use subscript zero-count
 * (e.g. `$0₄123` — four zeros after the decimal before `123`).
 */

const SUB = "\u2080\u2081\u2082\u2083\u2084\u2085\u2086\u2087\u2088\u2089";

function intToSubscript(n: number): string {
  if (!Number.isFinite(n) || n < 0) return String(n);
  return String(Math.min(n, 999))
    .split("")
    .map(c => SUB[parseInt(c, 10)] ?? c)
    .join("");
}

function trimSigDigits(s: string, maxLen = 8): string {
  const t = s.replace(/0+$/, "");
  if (t.length <= maxLen) return t;
  return t.slice(0, maxLen);
}

function sigDigitsFromMantissa(mantissa: string): string {
  const compact = mantissa.replace(".", "").replace(/^0+/, "").replace(/0+$/, "");
  return compact || "0";
}

/** Axis + crosshair: compact subscript for tiny USD; no parenthetical expansion. */
export function formatUsdPumpChart(usd: number): string {
  if (!Number.isFinite(usd)) return "—";
  const sign = usd < 0 ? "-" : "";
  const a = Math.abs(usd);
  if (a === 0) return "$0";

  if (a >= 1) {
    return `$${sign}${a.toLocaleString(undefined, {
      minimumFractionDigits: 0,
      maximumFractionDigits: 2,
    })}`;
  }
  if (a >= 0.01) {
    return `$${sign}${a.toLocaleString(undefined, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 4,
    })}`;
  }
  if (a >= 1e-3) {
    return `$${sign}${a.toLocaleString(undefined, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 8,
    })}`;
  }

  const [mantStr, expPart] = a.toExponential().split("e");
  const exp = parseInt(expPart, 10);
  if (exp >= -2) {
    return `$${sign}${a.toLocaleString(undefined, { maximumFractionDigits: 12 })}`;
  }

  const zeroCount = -exp - 1;
  if (zeroCount <= 0) {
    return `$${sign}${a.toFixed(10)}`;
  }

  const sig = trimSigDigits(sigDigitsFromMantissa(mantStr));
  return `$${sign}0${intToSubscript(zeroCount)}${sig}`;
}
