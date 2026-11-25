"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import type { Token } from "@/types";
import { formatUSD, calcBondingCurveProgress, timeAgo, cn } from "@/lib/utils";
import { tokenMediaSrc } from "@/lib/tokenMedia";

export default function LaunchpadTokenCard({
  token,
  featured = false,
  priority = false,
}: {
  token: Token;
  featured?: boolean;
  /** Eager-load for above-the-fold cards so art appears with the text. */
  priority?: boolean;
}) {
  const [failed, setFailed] = useState(false);
  const resolved = useMemo(() => tokenMediaSrc(token.imageUrl), [token.imageUrl]);
  const showImg = !!resolved && !failed;
  const graduated = token.phase === "graduated";
  const bonding = !graduated;
  const progress = calcBondingCurveProgress(token.solRaised, token.targetSOL);
  const eager = featured || priority;

  return (
    <Link
      href={`/token/${token.mint}`}
      className={cn(
        "group flex min-w-0 flex-col overflow-hidden rounded-xl border border-white/[0.09] bg-[#0c0c0c] transition-[border-color,background-color] duration-150",
        "hover:border-white/[0.16] hover:bg-[#101010]",
        featured && "flex-1"
      )}
    >
      {/* Absolute img so portrait assets can't stretch the square */}
      <div className="relative aspect-square w-full shrink-0 overflow-hidden bg-[#111]">
        {showImg ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={resolved}
            alt=""
            className="absolute inset-0 size-full object-cover object-center"
            onError={() => setFailed(true)}
            loading={eager ? "eager" : "lazy"}
            fetchPriority={eager ? "high" : "auto"}
            decoding="async"
            referrerPolicy="no-referrer"
          />
        ) : (
          <span className="absolute inset-0 flex items-center justify-center text-[13px] font-medium tracking-[0.08em] text-white/25">
            ${token.ticker}
          </span>
        )}

        {/* Age — plain caption, no frosted pill */}
        <span
          className="absolute left-2.5 top-2.5 text-[11px] font-medium tabular-nums tracking-tight text-white/90"
          style={{ textShadow: "0 1px 3px rgba(0,0,0,0.85)" }}
        >
          {timeAgo(token.createdAt)}
        </span>

        {graduated ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src="/omnipair/icon-dark-white.svg"
            alt=""
            className="absolute right-2.5 top-2.5 h-3.5 w-3.5 opacity-70"
          />
        ) : null}

        {bonding ? (
          <div className="absolute inset-x-0 bottom-0 h-[2px] bg-white/[0.08]">
            <div
              className="h-full bg-white/55"
              style={{ width: `${Math.min(Math.max(progress, 0), 100)}%` }}
            />
          </div>
        ) : null}
      </div>

      <div className="flex min-w-0 flex-col gap-1 border-t border-white/[0.06] px-2.5 py-2.5">
        <div className="flex min-w-0 items-baseline gap-1.5">
          <p className="truncate text-[14px] font-medium tracking-[-0.01em] text-white">
            {token.name}
          </p>
          <span className="shrink-0 text-[11px] font-medium tracking-wide text-white/30">
            ${token.ticker}
          </span>
        </div>
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-[15px] font-medium tabular-nums tracking-tight text-white/90">
            {formatUSD(token.marketCap)}
          </span>
          {bonding ? (
            <span className="text-[11px] tabular-nums text-white/30">
              {progress.toFixed(0)}%
            </span>
          ) : null}
        </div>
      </div>
    </Link>
  );
}
