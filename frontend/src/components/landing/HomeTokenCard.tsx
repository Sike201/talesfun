"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import type { Token } from "@/types";
import { formatUSD, calcBondingCurveProgress, timeAgo } from "@/lib/utils";
import { extractIpfsPath, resolveToHttps } from "@/lib/ipfs";

type Props = {
  token: Token;
  solUsd?: number | null;
  vol24hLamports?: string;
  rank?: number;
};

function mediaSrc(raw?: string): string | undefined {
  const t = raw?.trim();
  if (!t) return undefined;
  const path = extractIpfsPath(t);
  if (path) return `/api/media?cid=${encodeURIComponent(path)}`;
  const https = resolveToHttps(t);
  return https || undefined;
}

function tintFromSeed(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  const hue = h % 360;
  return `linear-gradient(145deg, hsl(${hue} 26% 24%), hsl(${(hue + 36) % 360} 18% 12%))`;
}

export default function HomeTokenCard({ token }: Props) {
  const [failed, setFailed] = useState(false);
  const resolved = useMemo(() => mediaSrc(token.imageUrl), [token.imageUrl]);
  const showImg = !!resolved && !failed;
  const graduated = token.phase === "graduated";
  const bonding = !graduated && token.phase !== "ready_to_graduate";
  const progress = calcBondingCurveProgress(token.solRaised, token.targetSOL);

  return (
    <Link href={`/token/${token.mint}`} className="group block">
      <div
        className="relative aspect-square w-full overflow-hidden rounded-2xl"
        style={{ background: tintFromSeed(token.mint) }}
      >
        {showImg ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={resolved}
            alt=""
            className="h-full w-full object-cover transition duration-300 group-hover:scale-[1.03]"
            onError={() => setFailed(true)}
            loading="lazy"
            referrerPolicy="no-referrer"
          />
        ) : (
          <span className="flex h-full w-full items-center justify-center text-2xl font-semibold tracking-wide text-white/55">
            {token.ticker.slice(0, 2).toUpperCase()}
          </span>
        )}

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
