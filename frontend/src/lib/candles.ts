/** OHLC candle for JSON API / lightweight-charts (`time` = Unix seconds). */
export type CandleOHLC = {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  /** Sum of trade notionals in SOL (|lamports|/1e9) in this bucket. */
  volume_sol: number;
};

/** Supported candle resolutions; buckets align to fixed UTC epoch multiples (see CANDLE_INTERVAL_MS). */
export type CandleInterval =
  | "1m"
  | "5m"
  | "15m"
  | "30m"
  | "1h"
  | "4h"
  | "6h"
  | "24h"
  | "1w";

export const CANDLE_INTERVAL_MS: Record<CandleInterval, number> = {
  "1m": 60_000,
  "5m": 5 * 60_000,
  "15m": 15 * 60_000,
  "30m": 30 * 60_000,
  "1h": 60 * 60_000,
  "4h": 4 * 60 * 60_000,
  "6h": 6 * 60 * 60_000,
  "24h": 24 * 60 * 60_000,
  "1w": 7 * 24 * 60 * 60_000,
};

/** UI / API order for interval buttons and parsing. */
export const CANDLE_INTERVALS_UI: readonly CandleInterval[] = [
  "1m",
  "5m",
  "15m",
  "30m",
  "1h",
  "4h",
  "6h",
  "24h",
  "1w",
] as const;

export type TradePriceTick = {
  timestamp: string;
  price_sol: number | string | null;
  sol_amount_raw?: string | null;
};

export function parseInterval(param: string | null): CandleInterval | null {
  if (!param) return null;
  return (CANDLE_INTERVALS_UI as readonly string[]).includes(param)
    ? (param as CandleInterval)
    : null;
}

/**
 * Pick a candle interval from the span of trade activity (UTC ms).
 * Coarser buckets when history is longer so the chart stays readable.
 */
export function suggestCandleInterval(startMs: number, endMs: number): CandleInterval {
  const span = Math.max(0, endMs - startMs);
  const m = 60_000;
  const h = 60 * m;
  const d = 24 * h;
  if (span <= 0) return "5m";
  if (span <= 20 * m) return "1m";
  if (span <= 3 * h) return "5m";
  if (span <= 12 * h) return "15m";
  if (span <= 3 * d) return "30m";
  if (span <= 10 * d) return "1h";
  if (span <= 45 * d) return "4h";
  if (span <= 120 * d) return "6h";
  if (span <= 365 * d) return "24h";
  return "1w";
}

/**
 * Aggregate chronological trades into OHLC buckets.
 * Bucketing: `bucketStart = floor(utcEpochMs / intervalMs) * intervalMs` (UTC / Unix timeline).
 */
type Bucket = { prices: number[]; volLamports: bigint };

function lamportsFromRaw(raw: string | null | undefined): bigint {
  if (raw == null || raw === "") return BigInt(0);
  try {
    const n = BigInt(raw);
    return n < BigInt(0) ? -n : n;
  } catch {
    return BigInt(0);
  }
}

export function aggregateTradesToCandles(
  rows: TradePriceTick[],
  interval: CandleInterval
): CandleOHLC[] {
  const ms = CANDLE_INTERVAL_MS[interval];
  const buckets = new Map<number, Bucket>();

  for (const r of rows) {
    const t = new Date(r.timestamp).getTime();
    if (!Number.isFinite(t)) continue;
    const p = typeof r.price_sol === "number" ? r.price_sol : Number(r.price_sol);
    if (!Number.isFinite(p) || p <= 0) continue;
    const bucketStart = Math.floor(t / ms) * ms;
    let b = buckets.get(bucketStart);
    if (!b) {
      b = { prices: [], volLamports: BigInt(0) };
      buckets.set(bucketStart, b);
    }
    b.prices.push(p);
    b.volLamports += lamportsFromRaw(
      typeof r.sol_amount_raw === "string" ? r.sol_amount_raw : undefined
    );
  }

  const keys = [...buckets.keys()].sort((a, b) => a - b);
  return keys.map(bucketStart => {
    const { prices, volLamports } = buckets.get(bucketStart)!;
    const open = prices[0]!;
    const close = prices[prices.length - 1]!;
    let high = open;
    let low = open;
    for (const x of prices) {
      if (x > high) high = x;
      if (x < low) low = x;
    }
    const volNum = Number(volLamports) / 1e9;
    return {
      time: Math.floor(bucketStart / 1000),
      open,
      high,
      low,
      close,
      volume_sol: Number.isFinite(volNum) ? volNum : 0,
    };
  });
}

/** `window` event `higher:trade-complete` — include tick fields when available for live candles. */
export type TradeCompleteEventDetail = {
  mint: string;
  timestamp?: string;
  price_sol?: number;
  sol_amount_raw?: string;
  source?: "bonding" | "omnipair";
};

function volumeSolFromAmountRaw(raw: string | null | undefined): number {
  if (raw == null || raw === "") return 0;
  try {
    const n = BigInt(raw);
    const abs = n < BigInt(0) ? -n : n;
    const v = Number(abs) / 1e9;
    return Number.isFinite(v) ? v : 0;
  } catch {
    return 0;
  }
}

/**
 * Merge one trade into the last candle (same UTC bucket) or append a new candle.
 * Prices are SOL/token. Returns a new array; if the trade falls in a bucket before the last candle, returns `candles` unchanged (caller should refetch).
 */
export function mergeTradeIntoCandles(
  candles: CandleOHLC[],
  tick: { timestamp: string; price_sol: number; sol_amount_raw: string },
  interval: CandleInterval
): CandleOHLC[] {
  const tradeMs = new Date(tick.timestamp).getTime();
  if (!Number.isFinite(tradeMs)) return candles;
  const price = tick.price_sol;
  if (!Number.isFinite(price) || price <= 0) return candles;

  const ms = CANDLE_INTERVAL_MS[interval];
  const bucketStartMs = Math.floor(tradeMs / ms) * ms;
  const timeSec = Math.floor(bucketStartMs / 1000);
  const volNum = volumeSolFromAmountRaw(tick.sol_amount_raw);

  const next = candles.slice();
  const last = next[next.length - 1];

  if (!last) {
    next.push({
      time: timeSec,
      open: price,
      high: price,
      low: price,
      close: price,
      volume_sol: volNum,
    });
    return next;
  }

  if (timeSec < last.time) {
    return candles;
  }

  if (timeSec === last.time) {
    next[next.length - 1] = {
      ...last,
      high: Math.max(last.high, price),
      low: Math.min(last.low, price),
      close: price,
      volume_sol: last.volume_sol + volNum,
    };
    return next;
  }

  next.push({
    time: timeSec,
    open: price,
    high: price,
    low: price,
    close: price,
    volume_sol: volNum,
  });
  return next;
}

export function tradeRowsTimeRangeMs(rows: TradePriceTick[]): {
  startMs: number;
  endMs: number;
} | null {
  if (!rows.length) return null;
  const first = new Date(rows[0]!.timestamp).getTime();
  const last = new Date(rows[rows.length - 1]!.timestamp).getTime();
  if (!Number.isFinite(first) || !Number.isFinite(last)) return null;
  return { startMs: first, endMs: last };
}

/**
 * Axis / crosshair labels for bonding-curve SOL-per-token prices (can be very small).
 */
export function formatBondingChartPrice(price: number): string {
  if (!Number.isFinite(price)) return "—";
  if (price === 0) return "0";
  const a = Math.abs(price);
  if (a >= 1)
    return price.toLocaleString(undefined, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 6,
    });
  if (a >= 1e-3)
    return price.toLocaleString(undefined, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 10,
    });
  if (a >= 1e-9)
    return price.toLocaleString(undefined, {
      maximumFractionDigits: 14,
    });
  return price.toExponential(4);
}
