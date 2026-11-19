"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  ColorType,
  createChart,
  type CandlestickData,
  type IChartApi,
  type ISeriesApi,
  LineStyle,
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
import DotGrid from "./DotGrid";

type CandleApiRow = CandlestickData & { volume_sol?: number };
type ChartVisual = "line" | "candles";

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
  const candleRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const areaRef = useRef<ISeriesApi<"Area"> | null>(null);
  const intervalRef = useRef<CandleInterval>("5m");
  const visualRef = useRef<ChartVisual>("line");
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
  const [visual, setVisual] = useState<ChartVisual>("line");
  const [autoActive, setAutoActive] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastClose, setLastClose] = useState<number | null>(null);
  const [changePct, setChangePct] = useState<number | null>(null);

  intervalRef.current = interval;
  visualRef.current = visual;

  const sym = (ticker?.trim() ?? "").length > 0 ? ticker!.trim() : "—";
  const usdMode = solUsd != null && Number.isFinite(solUsd) && solUsd > 0;
  const solUsdRate = usdMode ? solUsd! : 1;

  usdModeRef.current = usdMode;
  solUsdRateRef.current = solUsdRate;
  autoActiveRef.current = autoActive;

  const applyVisualSeries = useCallback((chart: IChartApi, mode: ChartVisual) => {
    if (candleRef.current) {
      chart.removeSeries(candleRef.current);
      candleRef.current = null;
    }
    if (areaRef.current) {
      chart.removeSeries(areaRef.current);
      areaRef.current = null;
    }

    const priceFormatter = usdModeRef.current ? formatUsdPumpChart : formatBondingChartPrice;
    const priceFormat = {
      type: "custom" as const,
      minMove: 1e-15,
      formatter: (p: number) => priceFormatter(p),
    };

    if (mode === "candles") {
      candleRef.current = chart.addCandlestickSeries({
        upColor: "#22c55e",
        downColor: "#ef4444",
        borderUpColor: "#16a34a",
        borderDownColor: "#dc2626",
        wickUpColor: "#22c55e",
        wickDownColor: "#ef4444",
        priceFormat,
      });
    } else {
      areaRef.current = chart.addAreaSeries({
        lineColor: "#22c55e",
        topColor: "rgba(34, 197, 94, 0.18)",
        bottomColor: "rgba(34, 197, 94, 0)",
        lineWidth: 3,
        crosshairMarkerVisible: true,
        crosshairMarkerRadius: 5,
        crosshairMarkerBorderColor: "#22c55e",
        crosshairMarkerBackgroundColor: "#0a0a0a",
        priceLineVisible: true,
        lastValueVisible: true,
        priceFormat,
      });
    }
  }, []);

  const pushCandlesToSeries = useCallback((usd: boolean, rate: number) => {
    const raw = candlesSolRef.current;
    if (!raw.length) return;
    const scale = (v: number) => (Number.isFinite(v) ? v * rate : v);
    const first = raw[0]!;
    const last = raw[raw.length - 1]!;
    const lastScaled = usd ? scale(last.close) : last.close;
    const firstScaled = usd ? scale(first.close) : first.close;
    setLastClose(lastScaled);
    if (firstScaled > 0) {
      setChangePct(((lastScaled - firstScaled) / firstScaled) * 100);
    }

    if (visualRef.current === "candles" && candleRef.current) {
      candleRef.current.setData(
        raw.map(({ time, open, high, low, close }) => ({
          time: time as UTCTimestamp,
          open: usd ? scale(open) : open,
          high: usd ? scale(high) : high,
          low: usd ? scale(low) : low,
          close: usd ? scale(close) : close,
        }))
      );
    } else if (areaRef.current) {
      areaRef.current.setData(
        raw.map(({ time, close }) => ({
          time: time as UTCTimestamp,
          value: usd ? scale(close) : close,
        }))
      );
    }
  }, []);

  const load = useCallback(
    async (mode: "manual" | "auto", opts?: { silent?: boolean }) => {
      const chart = chartRef.current;
      if (!chart) return;
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
        const body = (await res.json()) as CandlesResponse & {
          error?: string;
          unavailable?: boolean;
        };
        if (!res.ok && body.unavailable !== true) {
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
        pushCandlesToSeries(usdMode, solUsdRate);
        if (!silent) {
          chart.timeScale().fitContent();
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
    [mint, interval, usdMode, solUsdRate, pushCandlesToSeries]
  );

  loadRef.current = load;

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;

    const chart = createChart(el, {
      layout: {
        background: { type: ColorType.Solid, color: "transparent" },
        textColor: "rgba(255,255,255,0.38)",
        fontFamily:
          'var(--font-geist), ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
      },
      grid: {
        vertLines: { visible: false },
        horzLines: {
          color: "rgba(255,255,255,0.045)",
          style: LineStyle.Dotted,
        },
      },
      crosshair: {
        vertLine: {
          color: "rgba(255,255,255,0.16)",
          width: 1,
          style: LineStyle.Dashed,
          labelBackgroundColor: "#161616",
        },
        horzLine: {
          color: "rgba(255,255,255,0.16)",
          width: 1,
          style: LineStyle.Dashed,
          labelBackgroundColor: "#161616",
        },
      },
      rightPriceScale: {
        borderVisible: false,
        scaleMargins: { top: 0.1, bottom: 0.12 },
      },
      timeScale: {
        borderVisible: false,
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
      height: 400,
    });

    chartRef.current = chart;
    applyVisualSeries(chart, visualRef.current);
    void loadRef.current("manual");

    const ro = new ResizeObserver(() => {
      if (!wrapRef.current) return;
      chart.applyOptions({ width: wrapRef.current.clientWidth });
    });
    ro.observe(el);

    return () => {
      ro.disconnect();
      chart.remove();
      chartRef.current = null;
      candleRef.current = null;
      areaRef.current = null;
    };
  }, [mint, applyVisualSeries]);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    applyVisualSeries(chart, visual);
    pushCandlesToSeries(usdMode, solUsdRate);
    chart.timeScale().fitContent();
  }, [visual, applyVisualSeries, pushCandlesToSeries, usdMode, solUsdRate]);

  useEffect(() => {
    return () => {
      if (reconcileTimerRef.current) clearTimeout(reconcileTimerRef.current);
    };
  }, [mint]);

  useEffect(() => {
    if (!chartRef.current) return;
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

      const hasTick =
        detail.timestamp != null &&
        typeof detail.price_sol === "number" &&
        Number.isFinite(detail.price_sol) &&
        detail.price_sol > 0 &&
        typeof detail.sol_amount_raw === "string";

      if (hasTick) {
        const iv = effectiveIntervalRef.current;
        const prev = candlesSolRef.current;
        const merged = mergeTradeIntoCandles(
          prev,
          {
            timestamp: detail.timestamp!,
            price_sol: detail.price_sol!,
            sol_amount_raw: detail.sol_amount_raw!,
          },
          iv
        );

        if (merged === prev) {
          void loadRef.current(autoActiveRef.current ? "auto" : "manual", { silent: true });
          return;
        }

        candlesSolRef.current = merged;
        const last = merged[merged.length - 1]!;
        const rate = solUsdRateRef.current;
        const u = usdModeRef.current;
        const scale = (v: number) => (Number.isFinite(v) ? v * rate : v);

        if (visualRef.current === "candles" && candleRef.current) {
          candleRef.current.update({
            time: last.time as UTCTimestamp,
            open: u ? scale(last.open) : last.open,
            high: u ? scale(last.high) : last.high,
            low: u ? scale(last.low) : last.low,
            close: u ? scale(last.close) : last.close,
          });
        } else if (areaRef.current) {
          areaRef.current.update({
            time: last.time as UTCTimestamp,
            value: u ? scale(last.close) : last.close,
          });
        }
        setLastClose(u ? scale(last.close) : last.close);

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

  const priceLabel =
    lastClose != null
      ? usdMode
        ? formatUsdPumpChart(lastClose)
        : formatBondingChartPrice(lastClose)
      : "—";

  const up = changePct == null || changePct >= 0;

  return (
    <div className="relative overflow-hidden rounded-2xl">
      <div className="relative z-[2] flex flex-col gap-3 px-1 pb-2 pt-1 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <p className="text-[11px] font-medium text-white/35">
            {sym} / SOL{usdMode ? " · USD" : ""}
          </p>
          <div className="mt-1 flex flex-wrap items-baseline gap-2.5">
            <p className="text-[1.65rem] font-semibold tabular-nums tracking-tight text-white">
              {priceLabel}
            </p>
            {changePct != null ? (
              <span
                className={cn(
                  "text-[13px] font-semibold tabular-nums",
                  up ? "text-emerald-400" : "text-red-400"
                )}
              >
                {up ? "+" : ""}
                {changePct.toFixed(2)}%
              </span>
            ) : null}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="flex rounded-full bg-white/[0.05] p-0.5">
            {(["line", "candles"] as const).map(v => (
              <button
                key={v}
                type="button"
                onClick={() => setVisual(v)}
                className={cn(
                  "rounded-full px-2.5 py-1 text-[11px] font-semibold capitalize transition-all duration-200",
                  visual === v ? "bg-white text-[#0a0a0a] shadow-sm" : "text-white/40 hover:text-white/70"
                )}
              >
                {v === "line" ? "Line" : "Candles"}
              </button>
            ))}
          </div>
          <div className="flex flex-wrap gap-0.5">
            <button
              type="button"
              onClick={() => void load("auto")}
              className={cn(
                "rounded-full px-2 py-1 text-[10px] font-semibold transition-colors",
                autoActive
                  ? "bg-emerald-500/15 text-emerald-300"
                  : "text-white/35 hover:text-white/65"
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
                  "rounded-full px-2 py-1 text-[10px] font-semibold transition-colors",
                  !autoActive && interval === iv
                    ? "bg-white/[0.1] text-white"
                    : "text-white/35 hover:text-white/65"
                )}
              >
                {iv}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="relative w-full">
        <DotGrid
          className="absolute inset-0 z-0 opacity-90"
          dot="rgba(255,255,255,0.11)"
          gap={13}
          fade="radial"
        />
        <div
          className="pointer-events-none absolute inset-0 z-[1]"
          style={{
            background:
              "radial-gradient(ellipse 80% 70% at 50% 50%, transparent 25%, #0a0a0a 100%)",
          }}
        />
        <div ref={wrapRef} className="relative z-[2] w-full min-h-[400px]" />
        {loading ? (
          <div className="pointer-events-none absolute inset-0 z-[3] flex items-center justify-center">
            <span className="text-xs text-white/40">Loading chart…</span>
          </div>
        ) : null}
        {error ? (
          <div className="absolute bottom-3 left-3 right-3 z-[3] rounded-lg border border-amber-500/20 bg-amber-500/10 px-2 py-1 text-center text-[11px] text-amber-100/90">
            {error}
          </div>
        ) : null}
      </div>
    </div>
  );
}