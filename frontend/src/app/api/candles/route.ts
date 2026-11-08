import { NextRequest } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-server";
import {
  aggregateTradesToCandles,
  parseInterval,
  suggestCandleInterval,
  tradeRowsTimeRangeMs,
  type CandleInterval,
} from "@/lib/candles";

export const dynamic = "force-dynamic";

const MAX_ROWS = 25_000;

const INTERVAL_HELP =
  "interval must be one of: 1m, 5m, 15m, 30m, 1h, 4h, 6h, 24h, 1w — or use auto=1";

/**
 * GET /api/candles?mint=<base58>&interval=… * GET /api/candles?mint=<base58>&auto=1 — picks interval from trade time span, aggregates once.
 */
export async function GET(request: NextRequest) {
  const mint = request.nextUrl.searchParams.get("mint")?.trim() ?? "";
  const auto = request.nextUrl.searchParams.get("auto") === "1";
  const intervalParam = request.nextUrl.searchParams.get("interval")?.trim() ?? "5m";

  if (!mint) {
    return Response.json({ error: "mint is required" }, { status: 400 });
  }

  try {
    const { data, error } = await supabaseAdmin
      .from("trades")
      .select("timestamp, price_sol, sol_amount_raw")
      .eq("mint", mint)
      .order("timestamp", { ascending: true })
      .limit(MAX_ROWS);

    if (error) {
      console.warn("[candles] Supabase error", mint, error.message);
      return Response.json({ error: error.message }, { status: 500 });
    }

    const rows = data ?? [];
    const tradeTimeRange = tradeRowsTimeRangeMs(rows);

    let interval: CandleInterval;
    if (auto) {
      interval = tradeTimeRange
        ? suggestCandleInterval(tradeTimeRange.startMs, tradeTimeRange.endMs)
        : "5m";
    } else {
      const parsed = parseInterval(intervalParam);
      if (!parsed) {
        return Response.json({ error: INTERVAL_HELP }, { status: 400 });
      }
      interval = parsed;
    }

    const candles = aggregateTradesToCandles(rows, interval);

    if (auto) {
      console.log("[candles] auto=1 picked interval:", interval, "range:", tradeTimeRange);
    }

    if (candles.length > 0) {
      const allPx = candles.flatMap(c => [c.open, c.high, c.low, c.close]);
      const minPx = Math.min(...allPx);
      const maxPx = Math.max(...allPx);
      console.log("[candles] sample OHLCV (first 3):", candles.slice(0, 3));
      console.log("[candles] price range (SOL/token):", { min: minPx, max: maxPx });
    }

    return Response.json({
      mint,
      interval,
      autoSelected: auto,
      tradeTimeRange,
      count: candles.length,
      candles,
    });
  } catch (e) {
    return Response.json(
      { error: "Failed to build candles", details: String(e) },
      { status: 500 }
    );
  }
}
