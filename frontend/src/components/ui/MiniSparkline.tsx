"use client";

import { useMemo } from "react";
import { motion } from "framer-motion";
import DotGrid from "./DotGrid";
import { cn } from "@/lib/utils";
import { demoSparkValues } from "@/lib/demoMarket";

function seedPath(seed: string, points = 24): number[] {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  const out: number[] = [];
  for (let i = 0; i < points; i++) {
    h = (h * 1664525 + 1013904223) >>> 0;
    out.push(0.25 + (h % 1000) / 1400);
  }
  return out;
}

export default function MiniSparkline({
  seed,
  positive = true,
  values,
  className,
}: {
  seed: string;
  positive?: boolean;
  /** Optional real 0–1 series; otherwise deterministic seed path or demo curve */
  values?: number[];
  className?: string;
}) {
  const { linePath, areaPath, w, h, lastX, lastY } = useMemo(() => {
    const vals =
      values && values.length > 2
        ? values
        : seed.includes("AeTh3r")
          ? demoSparkValues(28)
          : seedPath(seed);
    const w = 200;
    const h = 56;
    const pad = 4;
    const xs = vals.map((_, i) => pad + (i / (vals.length - 1)) * (w - pad * 2));
    const ys = vals.map(v => h - pad - v * (h - pad * 2));
    const line = xs
      .map((x, i) => `${i === 0 ? "M" : "L"} ${x.toFixed(1)} ${ys[i]!.toFixed(1)}`)
      .join(" ");
    const area = `${line} L ${w - pad} ${h} L ${pad} ${h} Z`;
    return {
      linePath: line,
      areaPath: area,
      w,
      h,
      lastX: w - pad,
      lastY: ys[ys.length - 1]!,
    };
  }, [seed, values]);

  const stroke = positive ? "#22c55e" : "#f87171";
  const gid = `spark-${seed.replace(/[^a-zA-Z0-9]/g, "").slice(0, 10)}`;

  return (
    <div className={cn("relative h-14 w-full overflow-hidden rounded-lg", className)}>
      <DotGrid
        dot={positive ? "rgba(34,197,94,0.14)" : "rgba(248,113,113,0.12)"}
        gap={10}
        fade="radial"
      />
      <svg viewBox={`0 0 ${w} ${h}`} className="relative h-full w-full" preserveAspectRatio="none">
        <defs>
          <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={stroke} stopOpacity="0.28" />
            <stop offset="100%" stopColor={stroke} stopOpacity="0" />
          </linearGradient>
        </defs>
        <motion.path
          d={areaPath}
          fill={`url(#${gid})`}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.55, ease: "easeOut" }}
        />
        <motion.path
          d={linePath}
          fill="none"
          stroke={stroke}
          strokeWidth={2.4}
          strokeLinecap="round"
          strokeLinejoin="round"
          initial={{ pathLength: 0, opacity: 0.55 }}
          animate={{ pathLength: 1, opacity: 1 }}
          transition={{ duration: 0.9, ease: [0.22, 1, 0.36, 1] }}
        />
        <circle cx={lastX} cy={lastY} r="3.4" fill={stroke} />
      </svg>
    </div>
  );
}