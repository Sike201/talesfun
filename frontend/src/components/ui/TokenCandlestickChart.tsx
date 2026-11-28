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
  mergeLiveSpotIntoCandles,
  mergeTradeIntoCandles,
  type CandleInterval,
  type CandleOHLC,
  type TradeCompleteEventDetail,
} from "@/lib/candles";
import { formatUsdPumpChart } from "@/lib/chartUsdPriceFormat";
import { formatChartAxisTickLocal, formatChartCrosshairLocal } from "@/lib/chartTimeLocal";
import { cn, formatUSD } from "@/lib/utils";
import DotGrid from "./DotGrid";

type CandleApiRow = CandlestickData & { volume_sol?: number };
type ChartMetric = "price" | "mcap";

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

function formatChartMcap(usd: number): string {
  return formatUSD(usd);
}

export default function TokenCandlestickChart({
  mint,
  ticker,
  solUsd,
  livePriceSol = null,
  totalSupply = null,
}: {
  mint: string;
  ticker?: string;
  solUsd?: number | null;
  /** Live curve / Omnipair mid (SOL per token) — pins chart tip + headline to current spot. */
  livePriceSol?: number | null;
  /** Current circulating / mint supply (UI units) for market-cap mode. */
  totalSupply?: number | null;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const areaRef = useRef<ISeriesApi<"Area"> | null>(null);
  const intervalRef = useRef<CandleInterval>("5m");
  const metricRef = useRef<ChartMetric>("price");
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
  const supplyRef = useRef(0);

  const [interval, setInterval] = useState<CandleInterval>("5m");
  const [metric, setMetric] = useState<ChartMetric>("price");
  const [autoActive, setAutoActive] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastClose, setLastClose] = useState<number | null>(null);
  const [changePct, setChangePct] = useState<number | null>(null);

  intervalRef.current = interval;
  metricRef.current = metric;

  const sym = (ticker?.trim() ?? "").length > 0 ? ticker!.trim() : "—";
  const usdMode = solUsd != null && Number.isFinite(solUsd) && solUsd > 0;
  const solUsdRate = usdMode ? solUsd! : 1;
  const supply =
    totalSupply != null && Number.isFinite(totalSupply) && totalSupply > 0
      ? totalSupply
      : 0;
  const mcapAvailable = supply > 0 && usdMode;

  usdModeRef.current = usdMode;
  solUsdRateRef.current = solUsdRate;
  supplyRef.current = supply;
  autoActiveRef.current = autoActive;

  // If mcap isn't available yet, keep price selected.
  useEffect(() => {
    if (!mcapAvailable && metric === "mcap") setMetric("price");
  }, [mcapAvailable, metric]);

  const scalePoint = useCallback(
    (solPerToken: number, metricMode: ChartMetric, rate: number, supplyUi: number) => {
      if (!(Number.isFinite(solPerToken) && solPerToken > 0)) return solPerToken;
      if (metricMode === "mcap" && supplyUi > 0 && rate > 0) {
        return solPerToken * supplyUi * rate;
      }
      return rate > 0 && usdModeRef.current ? solPerToken * rate : solPerToken;
    },
    []
  );

  const applyAreaSeries = useCallback((chart: IChartApi, metricMode: ChartMetric) => {
    if (areaRef.current) {
      chart.removeSeries(areaRef.current);
      areaRef.current = null;
    }

    const priceFormatter =
      metricMode === "mcap"
        ? formatChartMcap
        : usdModeRef.current
          ? formatUsdPumpChart
          : formatBondingChartPrice;

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
      priceFormat: {
        type: "custom",
        minMove: 1e-15,
        formatter: (p: number) => priceFormatter(p),
      },
    });
  }, []);

  const pushCandlesToSeries = useCallback(() => {
    const raw = candlesSolRef.current.filter(
      c =>
        Number.isFinite(c.time) &&
        Number.isFinite(c.open) &&
        Number.isFinite(c.high) &&
        Number.isFinite(c.low) &&
        Number.isFinite(c.close) &&
        c.open > 0 &&
        c.close > 0
    );
    if (!raw.length) {
      areaRef.current?.setData([]);
      setLastClose(null);
      setChangePct(null);
      return;
    }

    const metricMode = metricRef.current;
    const rate = solUsdRateRef.current;
    const supplyUi = supplyRef.current;
    const first = raw[0]!;
    const last = raw[raw.length - 1]!;
    const lastScaled = scalePoint(last.close, metricMode, rate, supplyUi);
    const firstScaled = scalePoint(first.close, metricMode, rate, supplyUi);
    setLastClose(lastScaled);
    if (firstScaled > 0) {
      setChangePct(((lastScaled - firstScaled) / firstScaled) * 100);
    }

    if (!areaRef.current) return;
    areaRef.current.setData(
      raw.map(({ time, close }) => ({
        time: time as UTCTimestamp,
        value: scalePoint(close, metricMode, rate, supplyUi),
      }))
    );
  }, [scalePoint]);

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
        let mapped = raw.map(c => ({
          time: typeof c.time === "number" ? c.time : Number(c.time),
          open: c.open,
          high: c.high,
          low: c.low,
          close: c.close,
          volume_sol: c.volume_sol ?? 0,
        }));
        effectiveIntervalRef.current = effectiveInterval;
        if (livePriceSol != null && livePriceSol > 0) {
          mapped = mergeLiveSpotIntoCandles(
            mapped,
            livePriceSol,
            effectiveInterval
          );
        }
        candlesSolRef.current = mapped;
        pushCandlesToSeries();
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
    [mint, interval, livePriceSol, pushCandlesToSeries]
  );

  loadRef.current = load;

  // Keep chart tip + headline on the live mid (not a stale last-trade candle).
  useEffect(() => {
    if (!(livePriceSol != null && livePriceSol > 0)) return;
    if (!chartRef.current) return;
    candlesSolRef.current = mergeLiveSpotIntoCandles(
      candlesSolRef.current,
      livePriceSol,
      effectiveIntervalRef.current
    );
    pushCandlesToSeries();
  }, [livePriceSol, pushCandlesToSeries]);

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
    applyAreaSeries(chart, metricRef.current);
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
      areaRef.current = null;
    };
  }, [mint, applyAreaSeries]);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    applyAreaSeries(chart, metric);
    pushCandlesToSeries();
    chart.timeScale().fitContent();
  }, [metric, applyAreaSeries, pushCandlesToSeries]);

  // Supply / SOL-USD changes rescale the same SOL candles.
  useEffect(() => {
    pushCandlesToSeries();
  }, [totalSupply, solUsd, usdMode, pushCandlesToSeries]);

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
  }, [mint, interval]);

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
        const value = scalePoint(
          last.close,
          metricRef.current,
          solUsdRateRef.current,
          supplyRef.current
        );

        areaRef.current?.update({
          time: last.time as UTCTimestamp,
          value,
        });
        setLastClose(value);

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
  }, [mint, scalePoint]);

  const headline =
    lastClose != null
      ? metric === "mcap"
        ? formatChartMcap(lastClose)
        : usdMode
          ? formatUsdPumpChart(lastClose)
          : formatBondingChartPrice(lastClose)
      : "—";

  const up = changePct == null || changePct >= 0;

  return (
    <div className="relative overflow-hidden rounded-2xl">
      <div className="relative z-[2] flex flex-col gap-3 px-1 pb-2 pt-1 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <p className="max-w-full truncate text-[11px] font-medium tracking-wide text-white/35">
            {metric === "mcap"
              ? "Market cap"
              : usdMode
                ? `${sym}/USD`
                : `${sym}/SOL`}
          </p>
          <div className="mt-1 flex flex-wrap items-baseline gap-2.5">
            <p className="text-[1.65rem] font-semibold tabular-nums tracking-tight text-white">
              {headline}
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
            {(["price", "mcap"] as const).map(v => (
              <button
                key={v}
                type="button"
                disabled={v === "mcap" && !mcapAvailable}
                onClick={() => setMetric(v)}
                className={cn(
                  "rounded-full px-2.5 py-1 text-[11px] font-semibold transition-all duration-200",
                  metric === v
                    ? "bg-white text-[#0a0a0a] shadow-sm"
                    : "text-white/40 hover:text-white/70",
                  v === "mcap" && !mcapAvailable && "cursor-not-allowed opacity-40"
                )}
              >
                {v === "price" ? "Price" : "Market cap"}
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
