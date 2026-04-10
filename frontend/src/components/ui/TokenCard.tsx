"use client";

import Link from "next/link";
import Image from "next/image";
import { Token } from "@/types";
import { formatUSD, shortenAddress, timeAgo, calcBondingCurveProgress } from "@/lib/utils";
import { cn } from "@/lib/utils";

interface Props {
  token: Token;
  variant?: "grid" | "list";
}

export default function TokenCard({ token, variant = "grid" }: Props) {
  const progress = calcBondingCurveProgress(token.solRaised, token.targetSOL);
  const graduated = token.phase === "graduated";

  if (variant === "list") {
    return (
      <Link href={`/token/${token.id}`}>
        <div className="flex items-center gap-4 px-4 py-3 hover:bg-gray-50 transition-colors border-b border-gray-50 cursor-pointer">
          <div className="relative w-10 h-10 rounded-full overflow-hidden flex-shrink-0 bg-gray-100">
            <Image src={token.imageUrl} alt={token.name} fill className="object-cover" unoptimized />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-1.5">
              <span className="font-semibold text-sm text-gray-900 truncate">{token.name}</span>
              <span className="text-xs text-gray-400">${token.ticker}</span>
            </div>
            <span className="text-xs text-gray-400">{timeAgo(token.createdAt)}</span>
          </div>
          <div className="text-right">
            <p className="text-sm font-semibold text-gray-900">{formatUSD(token.marketCap)}</p>
            {!graduated ? (
              <div className="flex items-center gap-1.5">
                <div className="w-16 h-1.5 bg-gray-100 rounded-full overflow-hidden">
                  <div className="h-full rounded-full" style={{ width: `${progress}%`, background: "rgba(175,145,90,0.45)" }} />
                </div>
                <span className="text-[10px] text-gray-400">{progress.toFixed(0)}%</span>
              </div>
            ) : (
              <span className="text-[10px] font-medium" style={{ color: "#8a7050" }}>Graduated</span>
            )}
          </div>
        </div>
      </Link>
    );
  }

  return (
    <Link href={`/token/${token.id}`}>
      <div className="bg-white rounded-2xl border border-gray-100 p-4 cursor-pointer card-interactive group">
        {/* Top row */}
        <div className="flex items-start gap-3 mb-3">
          <div className="relative w-11 h-11 rounded-xl overflow-hidden flex-shrink-0 bg-gray-100">
            <Image src={token.imageUrl} alt={token.name} fill className="object-cover" unoptimized />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-1.5 mb-0.5">
              <span className="font-semibold text-sm text-gray-900 truncate">{token.name}</span>
              {graduated && (
                <span className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ background: "rgba(175,145,90,0.6)" }} />
              )}
            </div>
            <span className="text-xs text-gray-400">${token.ticker}</span>
          </div>
          <span className="text-[10px] text-gray-400 flex-shrink-0">{timeAgo(token.createdAt)}</span>
        </div>

        {/* Description */}
        <p className="text-xs text-gray-500 leading-relaxed mb-3 line-clamp-2">
          {token.description}
        </p>

        {/* Progress bar */}
        {!graduated && (
          <div className="mb-3">
            <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden">
              <div
                className="h-full rounded-full transition-all duration-500"
                style={{ width: `${progress}%`, background: "rgba(175,145,90,0.45)" }}
              />
            </div>
            <div className="flex justify-between text-[10px] text-gray-400 mt-1">
              <span>{token.solRaised.toFixed(1)} SOL</span>
              <span>{token.targetSOL} SOL</span>
            </div>
          </div>
        )}

        {/* Stats */}
        <div className={cn(
          "flex items-center justify-between pt-3 border-t border-gray-50",
          graduated && "mt-0"
        )}>
          <div>
            <p className="text-[10px] text-gray-400 uppercase tracking-wider">MC</p>
            <p className="text-sm font-semibold text-gray-900">{formatUSD(token.marketCap)}</p>
          </div>
          {graduated ? (
            <div className="text-right">
              <p className="text-[10px] text-gray-400 uppercase tracking-wider">Vol 24h</p>
              <p className="text-sm font-semibold text-gray-900">{formatUSD(token.volume24h ?? 0)}</p>
            </div>
          ) : (
            <div className="text-right">
              <p className="text-[10px] text-gray-400 uppercase tracking-wider">Price</p>
              <p className="text-sm font-semibold text-gray-900">{token.currentPrice.toFixed(8)}</p>
            </div>
          )}
          <div className="text-right">
            <p className="text-[10px] text-gray-400 uppercase tracking-wider">Creator</p>
            <p className="text-xs text-gray-500">{shortenAddress(token.creator, 3)}</p>
          </div>
        </div>
      </div>
    </Link>
  );
}
