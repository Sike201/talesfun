"use client";

import Link from "next/link";
import Image from "next/image";
import { ArrowUpRight } from "lucide-react";
import { MOCK_TOKENS } from "@/lib/mockData";
import GlassButton from "@/components/ui/GlassButton";
import HowItWorks from "@/components/ui/HowItWorks";
import AfterGraduation from "@/components/ui/AfterGraduation";
import { formatUSD, calcBondingCurveProgress, timeAgo } from "@/lib/utils";

export default function HomePage() {

  return (
    <div>
      {/* Hero */}
      <div className="flex flex-col items-center justify-center min-h-[calc(100vh-320px)] text-center px-8">
        <div className="flex items-center gap-2.5 mb-8 animate-[fadeSlideUp_0.6s_ease_forwards]">
          <img
            src="/omnipairlogo.svg"
            alt="Omnipair"
            className="w-6 h-6 animate-[spinOnce_1.2s_cubic-bezier(0.34,1.56,0.64,1)_0.2s_both]"
          />
          <span className="text-sm text-gray-400 font-medium">Built on Omnipair</span>
        </div>
        <h1 className="text-5xl sm:text-[68px] font-extrabold text-gray-900 leading-[1.06] tracking-tight mb-6 max-w-4xl animate-[fadeSlideUp_0.7s_ease_0.1s_both]">
          Launch an idea and make it liquid capital.
        </h1>
        <p className="text-gray-400 text-xl mb-10 max-w-xl leading-relaxed animate-[fadeSlideUp_0.7s_ease_0.2s_both]">
          Your token becomes usable collateral and a tradable asset with leverage and yield from the start.
        </p>
        <div className="animate-[fadeSlideUp_0.7s_ease_0.3s_both]">
          <GlassButton href="/create">get started</GlassButton>
        </div>
      </div>

      {/* ALL LAUNCHES */}
      <div className="w-full max-w-[1400px] mx-auto px-10 -mt-8 mb-24">
        <section>
          <div className="flex items-center justify-between mb-5">
            <p className="text-xs font-semibold text-gray-400 uppercase tracking-widest">All Launches</p>
            <Link href="/launches" className="text-sm font-medium text-gray-900 transition-colors hover:text-gray-600">
              See all →
            </Link>
          </div>

          <div className="rounded-2xl overflow-hidden bg-white shadow-sm" style={{ fontFamily: "'OpenRunde', sans-serif" }}>
            {/* Table header */}
            <div className="grid grid-cols-[3rem_2fr_1fr_1fr_1fr_1fr_1fr] px-6 py-3.5 border-b border-gray-100">
              {["#", "Name", "Market Cap", "24H Vol", "Price", "Creator Fees", "Total Debt"].map((h, idx) => (
                <span key={h} className={`text-[13px] font-semibold text-gray-400 ${idx > 1 ? "text-right" : ""}`}>{h}</span>
              ))}
            </div>

            {/* Table rows */}
            {MOCK_TOKENS.map((token, i) => {
              const graduated = token.phase === "graduated";
              const progress = calcBondingCurveProgress(token.solRaised, token.targetSOL);
              const solPrice = 148;
              return (
                <Link key={token.id} href={`/token/${token.id}`}>
                  <div className="grid grid-cols-[3rem_2fr_1fr_1fr_1fr_1fr_1fr] px-6 py-4 border-b border-gray-50 last:border-0 hover:bg-gray-50/70 transition-colors items-center cursor-pointer">
                    <span className="text-[14px] text-gray-400 tabular-nums">{i + 1}</span>

                    <div className="flex items-center gap-3.5 min-w-0">
                      <div className="relative w-10 h-10 rounded-xl overflow-hidden flex-shrink-0 bg-gray-100">
                        <Image src={token.imageUrl} alt={token.name} fill className="object-cover" unoptimized />
                      </div>
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 mb-0.5">
                          <span className="text-[14px] font-semibold text-gray-900 truncate leading-tight">{token.name}</span>
                          <span className="text-[14px] text-gray-400 flex-shrink-0">${token.ticker}</span>
                          {graduated && (
                            <span className="text-[11px] font-semibold px-1.5 py-0.5 rounded flex-shrink-0 bg-gray-100 text-gray-500">Grad</span>
                          )}
                        </div>
                        {!graduated ? (
                          <div className="flex items-center gap-2">
                            <div className="w-20 h-1 bg-gray-100 rounded-full overflow-hidden">
                              <div className="h-full rounded-full bg-gray-400" style={{ width: `${progress}%` }} />
                            </div>
                            <span className="text-[13px] text-gray-400 tabular-nums">{progress.toFixed(0)}%</span>
                          </div>
                        ) : (
                          <span className="text-[13px] text-gray-400">{timeAgo(token.createdAt)}</span>
                        )}
                      </div>
                    </div>

                    <span className="text-[14px] font-semibold text-gray-900 text-right tabular-nums">{formatUSD(token.marketCap)}</span>

                    <span className="text-[14px] text-gray-500 text-right tabular-nums">
                      {graduated && token.volume24h ? formatUSD(token.volume24h) : <span className="text-gray-300">—</span>}
                    </span>

                    <span className="text-[14px] text-gray-900 text-right tabular-nums">{token.currentPrice.toFixed(7)}</span>

                    <span className="text-[14px] text-gray-900 text-right tabular-nums">
                      {token.creatorFeesEarned ? formatUSD(token.creatorFeesEarned * solPrice) : <span className="text-gray-300">—</span>}
                    </span>

                    <span className="text-[14px] text-gray-500 text-right tabular-nums">
                      {token.lpFeesEarned ? formatUSD(token.lpFeesEarned * solPrice) : <span className="text-gray-300">—</span>}
                    </span>
                  </div>
                </Link>
              );
            })}
          </div>
        </section>
      </div>

      {/* Content */}
      <div className="max-w-2xl mx-auto px-8 pb-24">

        {/* HOW IT WORKS */}
        <HowItWorks />

        {/* AFTER GRADUATION */}
        <AfterGraduation />

        {/* RECENT WRITING */}
        <section>
          <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-4">Recent Writing</p>
          <Link href="/writing">
            <div className="rounded-lg overflow-hidden bg-white hover:shadow-md transition-shadow cursor-pointer">
              <div className="bg-gray-950 h-44 flex items-center justify-center">
                <span className="text-white text-4xl font-extrabold tracking-tight select-none">higher.run</span>
              </div>
              <div className="px-6 py-5">
                <div className="flex items-start justify-between gap-4 mb-2">
                  <h2 className="text-base font-bold text-gray-900 leading-snug">
                    Solana's Memecoin Economy Isn't Broken. It's Working Exactly As Designed.
                  </h2>
                  <ArrowUpRight size={16} className="text-gray-400 flex-shrink-0 mt-0.5" />
                </div>
                <p className="text-sm text-gray-500 italic leading-relaxed mb-4">
                  "Higher.run changes the structure entirely. Instead of forcing traders to move faster, it creates markets where conviction can actually survive."
                </p>
                <p className="text-xs text-gray-400">
                  higher.run Research&nbsp;/&nbsp;Protocol Overview&nbsp;/&nbsp;Apr 2026
                </p>
              </div>
            </div>
          </Link>
        </section>

      </div>
    </div>
  );
}
