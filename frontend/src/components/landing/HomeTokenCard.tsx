"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import type { Token } from "@/types";
import { formatUSD, calcBondingCurveProgress, timeAgo } from "@/lib/utils";
import { tokenMediaSrc } from "@/lib/tokenMedia";

type Props = {
  token: Token;
  solUsd?: number | null;
  vol24hLamports?: string;
  rank?: number;
  lastTradeAt?: string | null;
  showLastTradedBadge?: boolean;
  /** Eager-load for first-row / hero cards. */
  priority?: boolean;
};

function tintFromSeed(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  const hue = h % 360;
  return `linear-gradient(145deg, hsl(${hue} 26% 24%), hsl(${(hue + 36) % 360} 18% 12%))`;
}

export default function HomeTokenCard({
  token,
  showLastTradedBadge,
  lastTradeAt,
  priority = false,
}: Props) {
  const [failed, setFailed] = useState(false);
  const resolved = useMemo(() => tokenMediaSrc(token.imageUrl), [token.imageUrl]);
  const showImg = !!resolved && !failed;
  const graduated = token.phase === "graduated";
  const bonding = !graduated && token.phase !== "ready_to_graduate";
  const progress = calcBondingCurveProgress(token.solRaised, token.targetSOL);

  return (
    <Link href={`/token/${token.mint}`} className="group block">
      <div
        className="relative aspect-square w-full overflow-hidden rounded-2xl border border-white/[0.14]"
        style={{ background: tintFromSeed(token.mint) }}
      >
        {showImg ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={resolved}
            alt=""
            className="absolute inset-0 size-full object-cover object-center"
            onError={() => setFailed(true)}
            loading={priority ? "eager" : "lazy"}
            fetchPriority={priority ? "high" : "auto"}
            decoding="async"
            referrerPolicy="no-referrer"
          />
        ) : (
          <span className="absolute inset-0 flex items-center justify-center text-2xl font-semibold tracking-wide text-white/55">
            {token.ticker.slice(0, 2).toUpperCase()}
          </span>
        )}

        {showLastTradedBadge && lastTradeAt ? (
          <span className="absolute left-2.5 top-2.5 rounded-full bg-black/55 px-2 py-0.5 text-[10px] font-semibold tracking-wide text-emerald-300 shadow-sm ring-1 ring-white/15 backdrop-blur-sm">
            Last traded · {timeAgo(new Date(lastTradeAt))}
          </span>
        ) : null}

        {bonding ? (
          <div className="absolute inset-x-3 bottom-3">
            <div className="h-1 overflow-hidden rounded-full bg-black/45">
              <div
                className="h-full rounded-full"
                style={{
                  width: `${Math.min(progress, 100)}%`,
                  background: "#4ade80",
                }}
              />
            </div>
          </div>
        ) : null}
      </div>

      <div className="mt-3 min-w-0">
        <h3 className="truncate text-[15px] font-semibold tracking-tight text-white">
          {token.name}
        </h3>
        <p className="mt-0.5 truncate text-[13px] text-white/40">${token.ticker}</p>

        <p className="mt-2.5 text-[15px] font-semibold tabular-nums text-white">
          {formatUSD(token.marketCap)}{" "}
          <span className="text-[12px] font-medium text-white/35">MC</span>
        </p>

        <p className="mt-1.5 text-[12px] text-white/40">
          {graduated ? (
            <span style={{ color: "#4ade80" }}>Graduated · {timeAgo(token.createdAt)}</span>
          ) : bonding ? (
            <span>
              <span style={{ color: "#4ade80" }}>{progress.toFixed(0)}%</span>
              <span className="text-white/35"> · {timeAgo(token.createdAt)}</span>
            </span>
          ) : (
            <span style={{ color: "#fbbf24" }}>Near graduation · {timeAgo(token.createdAt)}</span>
          )}
        </p>
      </div>
    </Link>
  );
}
