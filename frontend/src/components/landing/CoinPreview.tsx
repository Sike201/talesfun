"use client";

import Image from "next/image";
import { FIXED_SUPPLY, GRADUATION_SOL } from "@/types";

type Props = {
  name: string;
  ticker: string;
  description: string;
  imagePreview: string;
  launchFeeSol?: string | null;
  creatorFeePct?: number;
};

export default function CoinPreview({
  name,
  ticker,
  description,
  imagePreview,
  launchFeeSol,
  creatorFeePct = 1,
}: Props) {
  const displayName = name.trim() || "Your token";
  const displayTicker = ticker.trim() || "TICKER";
  const feeLabel =
    launchFeeSol != null && launchFeeSol !== ""
      ? `~${launchFeeSol} SOL`
      : "Vault rent";

  return (
    <aside className="lg:sticky lg:top-20">
      <p className="mb-3 text-[12px] font-medium uppercase tracking-[0.14em] text-white/35">
        On the board
      </p>

      <div className="overflow-hidden rounded-xl border border-white/[0.09] bg-[#0c0c0c]">
        <div className="relative aspect-square w-full bg-[#111]">
          {imagePreview ? (
            <Image
              src={imagePreview}
              alt=""
              fill
              className="object-cover object-center"
              unoptimized
            />
          ) : (
            <div className="absolute inset-0 flex items-center justify-center text-[13px] font-medium tracking-[0.08em] text-white/25">
              ${displayTicker}
            </div>
          )}
        </div>

        <div className="space-y-3 border-t border-white/[0.06] p-3.5">
          <div className="flex min-w-0 items-baseline gap-1.5">
            <h3 className="truncate text-[15px] font-semibold tracking-tight text-white">
              {displayName}
            </h3>
            <span className="shrink-0 text-[11px] font-medium text-white/35">
              ${displayTicker}
            </span>
          </div>

          {description.trim() ? (
            <p className="line-clamp-2 text-[13px] leading-relaxed text-white/45">
              {description.trim()}
            </p>
          ) : null}

          <div className="grid grid-cols-2 gap-x-3 gap-y-3 border-t border-white/[0.06] pt-3">
            <div>
              <p className="text-[11px] text-white/35">Supply</p>
              <p className="mt-0.5 text-[13px] font-medium tabular-nums text-white/85">
                {FIXED_SUPPLY.toLocaleString("en-US")}
              </p>
            </div>
            <div>
              <p className="text-[11px] text-white/35">Graduates at</p>
              <p className="mt-0.5 text-[13px] font-medium tabular-nums text-white/85">
                {GRADUATION_SOL} SOL
              </p>
            </div>
            <div>
              <p className="text-[11px] text-white/35">Creator fee</p>
              <p className="mt-0.5 text-[13px] font-medium tabular-nums text-white/85">
                {creatorFeePct.toFixed(1)}%
              </p>
            </div>
            <div>
              <p className="text-[11px] text-white/35">Launch fee</p>
              <p className="mt-0.5 text-[13px] font-medium tabular-nums text-white/85">
                {feeLabel}
              </p>
            </div>
          </div>
        </div>
      </div>
    </aside>
  );
}
