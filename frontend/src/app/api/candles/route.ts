import { NextRequest } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-server";
import {
  aggregateTradesToCandles,
  parseInterval,
  suggestCandleInterval,
  tradeRowsTimeRangeMs,
  type CandleInterval,
} from "@/lib/candles";
import { generateDemoCandles, isDemoMarketMint } from "@/lib/demoMarket";
import { listLocalTrades } from "@/lib/localTradeStore";
import {
  getIndexerRpcConnection,
  indexOmnipairSwapsForMint,
} from "@/lib/omnipairIndexer";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

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

  if (isDemoMarketMint(mint)) {
    const interval = (auto ? "5m" : parseInterval(intervalParam) ?? "5m") as CandleInterval;
    const candles = generateDemoCandles(interval);
    return Response.json({
      mint,
      interval,
      autoSelected: auto,
      tradeTimeRange: {
        startMs: (candles[0]?.time ?? 0) * 1000,
        endMs: (candles[candles.length - 1]?.time ?? 0) * 1000,
      },
      count: candles.length,
      candles,
      demo: true,
    });
  }

  const started = Date.now();
  try {
    let rows: { timestamp: string; price_sol: number; sol_amount_raw: string }[] =
      [];
    let source: "supabase" | "local" | "merged" | "chain" = "supabase";

    const local = listLocalTrades(mint).map((t) => ({
      timestamp: t.timestamp,
      price_sol: t.price_sol,
      sol_amount_raw: t.sol_amount_raw,
    }));

    // Prefer warm Supabase — charts should not wait on RPC when DB is populated.
    try {
      const { data, error } = await supabaseAdmin
        .from("trades")
        .select("timestamp, price_sol, sol_amount_raw")
        .eq("mint", mint)
        .order("timestamp", { ascending: true })
        .limit(Math.min(MAX_ROWS, 5_000));
      if (error) {
        console.warn("[candles] Supabase error", mint, error.message);
      } else if (data && data.length > 0) {
        const byTs = new Map<string, (typeof rows)[number]>();
        for (const r of [...data, ...local]) {
          byTs.set(`${r.timestamp}:${r.price_sol}:${r.sol_amount_raw}`, r);
        }
        rows = [...byTs.values()];
        source = local.length > 0 ? "merged" : "supabase";
      } else if (local.length > 0) {
        rows = local;
        source = "local";
      }
    } catch (e) {
      console.warn("[candles] Supabase unreachable", e);
      if (local.length > 0) {
        rows = local;
        source = "local";
      }
    }

    rows = [...rows].sort(
      (a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp)
    );

    // Cold DB only — pull Omnipair swaps once, persist for next request.
    if (rows.length === 0) {
      try {
        const indexed = await indexOmnipairSwapsForMint(
          getIndexerRpcConnection(),
          mint,
          {
            limitPerPair: 80,
            knownSignatures: new Set(),
            deadlineMs: Date.now() + 18_000,
            persist: true,
          }
        );
        if (indexed.trades.length > 0) {
          rows = indexed.trades.map((t) => ({
            timestamp: t.timestamp,
            price_sol: t.price_sol,
            sol_amount_raw: t.sol_amount_raw,
          }));
          source = "chain";
          rows = [...rows].sort(
            (a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp)
          );
        }
      } catch (e) {
        console.warn("[candles] on-chain sync failed", mint, e);
      }
    }

    if (rows.length === 0) {
      return Response.json({
        mint,
        candles: [],
        interval: (auto ? "5m" : parseInterval(intervalParam) ?? "5m") as CandleInterval,
        count: 0,
        empty: true,
        source,
        hint: "No on-chain Omnipair swaps found for this mint yet",
      });
    }

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

    // Empty index → empty chart (never invent fake candles for real mints).
    if (candles.length === 0) {
      return Response.json({
        mint,
        interval,
        autoSelected: auto,
        tradeTimeRange,
        count: 0,
        candles: [],
        empty: true,
        hint: "No indexed trades yet — chart fills from on-chain swaps after the indexer/cron runs",
      });
    }

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

    console.info("[candles] ok", {
      mint,
      source,
      count: candles.length,
      ms: Date.now() - started,
    });
    return Response.json(
      {
        mint,
        interval,
        autoSelected: auto,
        tradeTimeRange,
        count: candles.length,
        candles,
        source,
        ms: Date.now() - started,
      },
      {
        headers: {
          "Cache-Control": "public, s-maxage=8, stale-while-revalidate=60",
          "x-tales-candles-source": source,
        },
      }
    );
  } catch (e) {
    console.warn("[candles] error (no synthetic fallback)", e);
    const interval = (auto ? "5m" : parseInterval(intervalParam) ?? "5m") as CandleInterval;
    return Response.json(
      {
        mint,
        interval,
        autoSelected: auto,
        count: 0,
        candles: [],
        unavailable: true,
        error: e instanceof Error ? e.message : String(e),
      },
      { status: 500 }
    );
  }
}
