"use client";

import Image from "next/image";
import { GRADUATION_SOL } from "@/types";

type Props = {
  name: string;
  ticker: string;
  description: string;
  imagePreview: string;
};

export default function CoinPreview({
  name,
  ticker,
  description,
  imagePreview,
}: Props) {
  const displayName = name.trim() || "Your coin";
  const displayTicker = ticker.trim() || "TICKER";

  return (
    <aside className="rounded-2xl bg-white/[0.035] p-5">
      <p className="text-xs font-semibold uppercase tracking-[0.14em] text-white/40">
        Preview
      </p>

      <div className="mt-4 overflow-hidden rounded-2xl bg-black/40">
        <div className="relative aspect-square w-full bg-white/[0.04]">
          {imagePreview ? (
            <Image
              src={imagePreview}
              alt=""
              fill
              className="object-cover"
              unoptimized
            />
          ) : (
            <div className="flex h-full w-full items-center justify-center px-6 text-center text-sm text-white/30">
              A preview of how the coin will look
            </div>
          )}
        </div>

        <div className="space-y-3 p-4">
          <div>
            <h3 className="truncate text-[17px] font-semibold text-white">
              {displayName}
            </h3>
            <p className="mt-0.5 text-sm text-white/40">${displayTicker}</p>
          </div>

          {description.trim() ? (
            <p className="line-clamp-3 text-sm leading-relaxed text-white/55">
              {description.trim()}
            </p>
          ) : (
            <p className="text-sm text-white/30">No description yet</p>
          )}

          <div className="flex items-center justify-between border-t border-white/[0.06] pt-3 text-xs text-white/40">
            <span>Bonding curve</span>
            <span className="tabular-nums text-white/65">
              0 / {GRADUATION_SOL} SOL
            </span>
          </div>
        </div>
      </div>
    </aside>
  );
}
