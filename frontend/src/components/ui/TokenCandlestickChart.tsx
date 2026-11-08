"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  ColorType,
  createChart,
  type CandlestickData,
  type IChartApi,
  type ISeriesApi,
  TickMarkType,
  type Time,
  type UTCTimestamp,
} from "lightweight-charts";
import {
  CANDLE_INTERVALS_UI,
  formatBondingChartPrice,
  mergeTradeIntoCandles,
  type CandleInterval,
  type CandleOHLC,
  type TradeCompleteEventDetail,
} from "@/lib/candles";
import { formatUsdPumpChart } from "@/lib/chartUsdPriceFormat";
import { formatChartAxisTickLocal, formatChartCrosshairLocal } from "@/lib/chartTimeLocal";
import { cn } from "@/lib/utils";

type CandleApiRow = CandlestickData & { volume_sol?: number };

type CandlesResponse = {
  candles: CandleApiRow[];
  interval: CandleInterval;
  autoSelected?: boolean;
  tradeTimeRange?: { startMs: number; endMs: number } | null;
  error?: string;
};

function applyIntervalToChart(chart: IChartApi, interval: CandleInterval) {
  chart.applyOptions({
    timeScale: {
      timeVisible: true,
      secondsVisible: interval === "1m",
      tickMarkFormatter: (time: Time, tickMarkType: TickMarkType) =>
        formatChartAxisTickLocal(time, tickMarkType, interval),
    },
    localization: {
      locale: navigator.language,
      timeFormatter: (t: Time) => formatChartCrosshairLocal(t, interval),
    },
  });
}

export default function TokenCandlestickChart({
  mint,
  ticker,
  solUsd,
}: {
  mint: string;
  ticker?: string;
  solUsd?: number | null;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const intervalRef = useRef<CandleInterval>("5m");
  const skipNextIntervalFetchRef = useRef(false);
  const loadRef = useRef<(mode: "manual" | "auto", opts?: { silent?: boolean }) => Promise<void>>(
    async () => {}
  );
  const candlesSolRef = useRef<CandleOHLC[]>([]);
  const effectiveIntervalRef = useRef<CandleInterval>("5m");
  const autoActiveRef = useRef(false);
  const reconcileTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const usdModeRef = useRef(false);
  const solUsdRateRef = useRef(1);

  const [interval, setInterval] = useState<CandleInterval>("5m");
  const [autoActive, setAutoActive] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  intervalRef.current = interval;

  const sym = (ticker?.trim() ?? "").length > 0 ? ticker!.trim() : "—";
  const usdMode = solUsd != null && Number.isFinite(solUsd) && solUsd > 0;
  const solUsdRate = usdMode ? solUsd! : 1;

  usdModeRef.current = usdMode;
  solUsdRateRef.current = solUsdRate;
  autoActiveRef.current = autoActive;

  const load = useCallback(
    async (mode: "manual" | "auto", opts?: { silent?: boolean }) => {
      const series = seriesRef.current;
      const chart = chartRef.current;
      if (!series || !chart) return;
      const silent = opts?.silent === true;
      if (!silent) {
        setLoading(true);
        setError(null);
      }
      try {
        const url =
          mode === "auto"
            ? `/api/candles?mint=${encodeURIComponent(mint)}&auto=1`
            : `/api/candles?mint=${encodeURIComponent(mint)}&interval=${interval}`;
        const res = await fetch(url);
        const body = (await res.json()) as CandlesResponse & { error?: string };
        if (!res.ok) {
          throw new Error(body.error || `HTTP ${res.status}`);
        }

        const effectiveInterval = body.interval;
        if (mode === "auto") {
          setAutoActive(true);
          if (effectiveInterval !== interval) {
            skipNextIntervalFetchRef.current = true;
            setInterval(effectiveInterval);
          }
        } else {
          setAutoActive(false);
        }

        applyIntervalToChart(chart, effectiveInterval);

        const priceFormatter = usdMode ? formatUsdPumpChart : formatBondingChartPrice;
        series.applyOptions({
          priceFormat: {
            type: "custom",
            minMove: 1e-15,
            formatter: (p: number) => priceFormatter(p),
          },
        });

        const raw = body.candles ?? [];
        candlesSolRef.current = raw.map(c => ({
          time: typeof c.time === "number" ? c.time : Number(c.time),
          open: c.open,
          high: c.high,
          low: c.low,
          close: c.close,
          volume_sol: c.volume_sol ?? 0,
        }));
        effectiveIntervalRef.current = effectiveInterval;

        const scale = (v: number) => (Number.isFinite(v) ? v * solUsdRate : v);
        const data: CandlestickData[] = candlesSolRef.current.map(({ time, open, high, low, close }) => ({
          time: time as UTCTimestamp,
          open: usdMode ? scale(open) : open,
          high: usdMode ? scale(high) : high,
          low: usdMode ? scale(low) : low,
          close: usdMode ? scale(close) : close,
        }));
        series.setData(data);
        if (!silent) {
          chart.timeScale().fitContent();
        }

        console.log(
          "[chart:bonding] selected interval:",
          effectiveInterval,
          "auto:",
          body.autoSelected === true
        );
        if (body.tradeTimeRange) {
          console.log("[chart:bonding] first/last trade (ms):", body.tradeTimeRange);
        }
        if (raw.length > 0) {
          const allPx = raw.flatMap(c => [c.open, c.high, c.low, c.close]);
          console.log("[chart:bonding] price range SOL/token:", {
            min: Math.min(...allPx),
            max: Math.max(...allPx),
          });
          if (usdMode) {
            const allUsd = allPx.map(scale);
            console.log("[chart:bonding] price range (USD display):", {
              min: Math.min(...allUsd),
              max: Math.max(...allUsd),
            });
          }
          const first = raw[0]!;
          const last = raw[raw.length - 1]!;
          console.log("[chart:bonding] first/last candle unix (s):", first.time, last.time);
          console.log(
            "[chart:bonding] example hover (local):",
            formatChartCrosshairLocal(last.time as Time, effectiveInterval)
          );
        } else {
          console.log("[chart:bonding] no candles for mint", mint.slice(0, 8) + "…");
        }
      } catch (e) {
        if (!silent) {
          setError(e instanceof Error ? e.message : "Failed to load chart");
        }
      } finally {
        if (!silent) {
          setLoading(false);
        }
      }
    },
    [mint, interval, usdMode, solUsdRate]
  );

  loadRef.current = load;

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;

    const chart = createChart(el, {
      layout: {
        background: { type: ColorType.Solid, color: "#ffffff" },
        textColor: "#4b5563",
        fontFamily:
          'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
      },
      grid: {
        vertLines: { color: "#f3f4f6" },
        horzLines: { color: "#f3f4f6" },
      },
      crosshair: {
        vertLine: { color: "#d1d5db", width: 1 as const, labelBackgroundColor: "#f9fafb" },
        horzLine: { color: "#d1d5db", width: 1 as const, labelBackgroundColor: "#f9fafb" },
      },
      rightPriceScale: {
        borderColor: "#e5e7eb",
        scaleMargins: { top: 0.06, bottom: 0.06 },
      },
      timeScale: {
        borderColor: "#e5e7eb",
        timeVisible: true,
        secondsVisible: intervalRef.current === "1m",
        tickMarkFormatter: (time: Time, tickMarkType: TickMarkType) =>
          formatChartAxisTickLocal(time, tickMarkType, intervalRef.current),
      },
      localization: {
        locale: navigator.language,
        timeFormatter: (t: Time) => formatChartCrosshairLocal(t, intervalRef.current),
      },
      width: el.clientWidth,
      height: 360,
    });

    const series = chart.addCandlestickSeries({
      upColor: "#16a34a",
      downColor: "#dc2626",
      borderUpColor: "#15803d",
      borderDownColor: "#b91c1c",
      wickUpColor: "#16a34a",
      wickDownColor: "#dc2626",
      priceFormat: {
        type: "custom",
        minMove: 1e-15,
        formatter: (p: number) => formatBondingChartPrice(p),
      },
    });

    chartRef.current = chart;
    seriesRef.current = series;

    const ro = new ResizeObserver(() => {
      if (!wrapRef.current) return;
      chart.applyOptions({ width: wrapRef.current.clientWidth });
    });
    ro.observe(el);

    return () => {
      ro.disconnect();
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
    };
  }, [mint]);

  useEffect(() => {
    return () => {
      if (reconcileTimerRef.current) {
        clearTimeout(reconcileTimerRef.current);
        reconcileTimerRef.current = null;
      }
    };
  }, [mint]);

  useEffect(() => {
    if (!seriesRef.current) return;
    if (skipNextIntervalFetchRef.current) {
      skipNextIntervalFetchRef.current = false;
      return;
    }
    void loadRef.current("manual");
  }, [mint, interval, solUsd, usdMode]);

  useEffect(() => {
    const onTradeComplete = (e: Event) => {
      const detail = (e as CustomEvent<TradeCompleteEventDetail>).detail;
      if (detail?.mint !== mint) return;

      const series = seriesRef.current;
      if (!series) return;

      const hasTick =
        detail.timestamp != null &&
        typeof detail.price_sol === "number" &&
        Number.isFinite(detail.price_sol) &&
        detail.price_sol > 0 &&
        typeof detail.sol_amount_raw === "string";

      if (hasTick) {
        const interval = effectiveIntervalRef.current;
        const prev = candlesSolRef.current;
        const merged = mergeTradeIntoCandles(prev, {
          timestamp: detail.timestamp!,
          price_sol: detail.price_sol!,
          sol_amount_raw: detail.sol_amount_raw!,
        }, interval);

        if (merged === prev) {
          void loadRef.current(autoActiveRef.current ? "auto" : "manual", { silent: true });
          return;
        }

        candlesSolRef.current = merged;
        const last = merged[merged.length - 1]!;
        const rate = solUsdRateRef.current;
        const u = usdModeRef.current;
        const scale = (v: number) => (Number.isFinite(v) ? v * rate : v);
        series.update({
          time: last.time as UTCTimestamp,
          open: u ? scale(last.open) : last.open,
          high: u ? scale(last.high) : last.high,
          low: u ? scale(last.low) : last.low,
          close: u ? scale(last.close) : last.close,
        });

        if (reconcileTimerRef.current) clearTimeout(reconcileTimerRef.current);
        reconcileTimerRef.current = setTimeout(() => {
          reconcileTimerRef.current = null;
          void loadRef.current(autoActiveRef.current ? "auto" : "manual", { silent: true });
        }, 800);
        return;
      }

      void loadRef.current(autoActiveRef.current ? "auto" : "manual");
    };
    window.addEventListener("higher:trade-complete", onTradeComplete);
    return () => window.removeEventListener("higher:trade-complete", onTradeComplete);
  }, [mint]);

  return (
    <div className="bg-white rounded-lg overflow-hidden border border-gray-100">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between px-3 py-2 border-b border-gray-100">
        <span className="text-xs font-semibold text-gray-900 shrink-0">
          {sym} / SOL{usdMode ? " (USD)" : ""}
        </span>
        <div className="flex flex-wrap gap-1 justify-end">
          <button
            type="button"
            onClick={() => void load("auto")}
            className={cn(
              "text-[10px] px-2 py-0.5 rounded font-medium transition-colors border border-transparent",
              autoActive
                ? "bg-emerald-700 text-white"
                : "bg-gray-100 text-gray-600 hover:bg-gray-200 border-gray-200"
            )}
          >
            Auto
          </button>
          {CANDLE_INTERVALS_UI.map(iv => (
            <button
              key={iv}
              type="button"
              onClick={() => {
                setAutoActive(false);
                setInterval(iv);
              }}
              className={cn(
                "text-[10px] px-2 py-0.5 rounded font-medium transition-colors",
                !autoActive && interval === iv
                  ? "bg-gray-900 text-white"
                  : "bg-gray-100 text-gray-500 hover:bg-gray-200"
              )}
            >
              {iv}
            </button>
          ))}
        </div>
      </div>
      <div ref={wrapRef} className="relative w-full min-h-[360px]">
        {loading && (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-white/70 pointer-events-none">
            <span className="text-xs text-gray-500">Loading chart…</span>
          </div>
        )}
        {error && (
          <div className="absolute bottom-2 left-2 right-2 z-10 text-center text-[11px] text-red-600 bg-white/95 border border-red-100 rounded px-2 py-1 shadow-sm">
            {error}
          </div>
        )}
      </div>
    </div>
  );
}
