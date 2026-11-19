import type { CandleInterval, CandleOHLC } from "@/lib/candles";
import { CANDLE_INTERVAL_MS } from "@/lib/candles";
import { GRADUATION_SOL, type Token } from "@/types";

/** Stable demo market for UI polish when chain/index has no candles. */
export const DEMO_MARKET_MINT = "AeTh3rDemoMarketChartLines11111111111111";

export const DEMO_TOKEN: Token = {
  id: "demo-aether",
  mint: DEMO_MARKET_MINT,
  name: "Aether",
  ticker: "AETH",
  description: "Demo market with live-looking chart data for Tales UI.",
  about:
    "Aether is a demo graduated market used to preview Tales charts, sparklines, and the trading layout. Candles are generated locally so the chart always shows real lines.",
  imageUrl: "/tales-mark.png",
  creator: "DemoCreator1111111111111111111111111111",
  creatorFeeRecipient: "DemoCreator1111111111111111111111111111",
  website: "https://omnipair.fi",
  twitter: "Talesdotfun",
  createdAt: new Date(Date.now() - 36 * 60 * 60 * 1000),
  phase: "graduated",
  solRaised: GRADUATION_SOL,
  targetSOL: GRADUATION_SOL,
  tokensSold: 8_200_000,
  totalSupply: 10_000_000,
  currentPrice: 0.0000124,
  launchPrice: 0.0000038,
  marketCap: 124_000,
  funders: 418,
  creatorFeesEarned: 2.18,
  lpFeesEarned: 3.42,
  volume24h: 556_900,
};

export function isDemoMarketMint(mint: string): boolean {
  return mint.trim() === DEMO_MARKET_MINT;
}

function mulberry32(seed: number) {
  return () => {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Deterministic OHLC series that looks like a real market move.
 * Always returns enough points for a visible line / candles.
 */
export function generateDemoCandles(interval: CandleInterval): CandleOHLC[] {
  const stepMs = CANDLE_INTERVAL_MS[interval];
  const count =
    interval === "1m"
      ? 180
      : interval === "5m"
        ? 120
        : interval === "15m"
          ? 96
          : interval === "30m"
            ? 80
            : interval === "1h"
              ? 72
              : interval === "4h"
                ? 60
                : interval === "6h"
                  ? 48
                  : interval === "24h"
                    ? 40
                    : 28;

  const now = Date.now();
  const aligned = Math.floor(now / stepMs) * stepMs;
  const rnd = mulberry32(0xa37e + interval.length * 97);

  let price = 0.0000092;
  const out: CandleOHLC[] = [];

  for (let i = count; i >= 1; i--) {
    const tMs = aligned - i * stepMs;
    const drift = (rnd() - 0.48) * 0.00000028;
    const shock = rnd() > 0.94 ? (rnd() - 0.5) * 0.0000009 : 0;
    const open = price;
    const close = Math.max(0.0000015, open + drift + shock);
    const wick = Math.abs(close - open) * (0.35 + rnd() * 1.4) + open * 0.004 * rnd();
    const high = Math.max(open, close) + wick * (0.2 + rnd() * 0.8);
    const low = Math.max(0.0000012, Math.min(open, close) - wick * (0.2 + rnd() * 0.8));
    const volume_sol = 0.4 + rnd() * 8.5 + (Math.abs(close - open) / open) * 40;
    out.push({
      time: Math.floor(tMs / 1000),
      open,
      high,
      low,
      close,
      volume_sol,
    });
    price = close;
  }

  return out;
}

/** Sparkline values 0–1 from demo closes (for directory cards). */
export function demoSparkValues(points = 28): number[] {
  const candles = generateDemoCandles("5m").slice(-points);
  const closes = candles.map(c => c.close);
  const min = Math.min(...closes);
  const max = Math.max(...closes);
  const span = Math.max(max - min, 1e-12);
  return closes.map(c => 0.12 + ((c - min) / span) * 0.76);
}