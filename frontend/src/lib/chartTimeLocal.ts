import { TickMarkType, type Time } from "lightweight-charts";
import type { CandleInterval } from "@/lib/candles";

/** Local browser time — same convention for axis ticks and crosshair (not UTC / ISO). */
function asLocalDate(time: Time): Date | null {
  if (typeof time !== "number") return null;
  return new Date(time * 1000);
}

export function formatChartAxisTickLocal(
  time: Time,
  tickMarkType: TickMarkType,
  interval: CandleInterval
): string | null {
  const d = asLocalDate(time);
  if (!d) return null;
  const showSeconds = interval === "1m" && tickMarkType === TickMarkType.TimeWithSeconds;

  if (tickMarkType === TickMarkType.Year) {
    return d.toLocaleString(undefined, { year: "numeric" });
  }
  if (tickMarkType === TickMarkType.Month) {
    return d.toLocaleString(undefined, { month: "short", year: "numeric" });
  }
  if (tickMarkType === TickMarkType.DayOfMonth) {
    return d.toLocaleString(undefined, {
      weekday: "short",
      month: "short",
      day: "numeric",
    });
  }
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    ...(showSeconds ? { second: "2-digit" } : {}),
  });
}

/**
 * Crosshair / hover time — must match local convention used on the axis.
 * lightweight-charts defaults can look UTC; overriding `localization.timeFormatter` fixes that.
 */
export function formatChartCrosshairLocal(time: Time, interval: CandleInterval): string {
  const d = asLocalDate(time);
  if (!d) return "";

  if (interval === "1w" || interval === "24h" || interval === "6h" || interval === "4h") {
    return d.toLocaleString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
  }
  if (interval === "1h" || interval === "30m" || interval === "15m" || interval === "5m") {
    return d.toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
  }
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}
