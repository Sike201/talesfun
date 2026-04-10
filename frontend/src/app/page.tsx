"use client";

import Link from "next/link";
import Image from "next/image";
import { ArrowUpRight } from "lucide-react";
import { MOCK_TOKENS } from "@/lib/mockData";
import TokenCard from "@/components/ui/TokenCard";
import GlassButton from "@/components/ui/GlassButton";

export default function HomePage() {
  const graduated = MOCK_TOKENS.filter(t => t.phase === "graduated");

  return (
    <div>
      {/* Hero */}
      <div className="flex flex-col items-center justify-center min-h-[calc(100vh-200px)] text-center px-8 pb-8 pt-4">
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

      {/* Content */}
      <div className="max-w-2xl mx-auto px-8 pb-24">

        {/* RECENT WRITING */}
        <section className="mb-16">
          <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-4">Recent Writing</p>
          <Link href="/writing">
            <div className="rounded-lg overflow-hidden bg-white hover:shadow-md transition-shadow cursor-pointer">
              <div className="bg-gray-950 h-44 flex items-center justify-center">
                <span className="text-white text-4xl font-extrabold tracking-tight select-none">higher.run</span>
              </div>
              <div className="px-6 py-5">
                <div className="flex items-start justify-between gap-4 mb-2">
                  <h2 className="text-base font-bold text-gray-900 leading-snug">
                    The Higher.run Protocol: On-Chain Capital Markets for Every Token
                  </h2>
                  <ArrowUpRight size={16} className="text-gray-400 flex-shrink-0 mt-0.5" />
                </div>
                <p className="text-sm text-gray-500 italic leading-relaxed mb-4">
                  "A token that can be borrowed against, leveraged, and shorted on day one is no longer
                  just a speculative asset — it's a financial instrument."
                </p>
                <p className="text-xs text-gray-400">
                  higher.run Research&nbsp;/&nbsp;Protocol Overview&nbsp;/&nbsp;Apr 2026
                </p>
              </div>
            </div>
          </Link>
        </section>

        {/* HOW IT WORKS */}
        <section className="mb-16">
          <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-5">How It Works</p>
          <div className="space-y-3">
            {[
              { n: "1", label: "Launch", desc: "Deploy a token with fixed 10M supply. Mint authority revoked on graduation." },
              { n: "2", label: "Fund", desc: "Community contributes SOL on a bonding curve. Fair launch, no presale." },
              { n: "3", label: "Graduate", desc: "Auto-migrates to an Omnipair GAMM pool with full capital markets utility." },
              { n: "4", label: "Earn", desc: "Collect 0.5% perpetual royalties on every swap. Forever." },
            ].map(({ n, label, desc }) => (
              <div key={n} className="rounded-lg px-6 py-4 bg-white">
                <span className="text-sm text-gray-400 mr-3">{n}</span>
                <span className="text-sm font-semibold text-gray-900">{label}</span>
                <span className="text-sm text-gray-500 ml-2">{desc}</span>
              </div>
            ))}
          </div>
        </section>

        {/* AFTER GRADUATION */}
        <section className="mb-16">
          <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">After Graduation</p>
          <h2 className="text-2xl font-bold text-gray-900 mb-2">Every token becomes a capital markets instrument.</h2>
          <p className="text-sm text-gray-400 mb-6 max-w-xl">
            Once the bonding curve target is reached, your token auto-migrates into an Omnipair GAMM pool — a unified liquidity layer that unlocks institutional-grade DeFi primitives instantly.
          </p>
          <div className="space-y-3">
            {[
              { title: "Spot Trading", desc: "Deep on-chain liquidity. Instant execution. No orderbook required." },
              { title: "Borrow Against Your Tokens", desc: "Deposit your tokens as collateral and borrow SOL or USDC directly from the GAMM pool. Access liquidity without selling a single token." },
              { title: "Leveraged Long Positions", desc: "Amplify exposure through recursive borrowing — 2x, 3x, or higher — all within the same pool. No external margin protocol." },
              { title: "Short Selling", desc: "Take the other side. Borrow the token, sell into the pool, and profit from downside. Full short capability, natively." },
              { title: "Supply Liquidity & Earn Yield", desc: "Provide capital to the pool. Earn swap fees, lending interest, and creator royalty distributions. Passive, composable yield." },
            ].map(({ title, desc }) => (
              <div key={title} className="rounded-lg px-6 py-5 bg-white hover:shadow-sm transition-shadow">
                <h3 className="text-sm font-semibold text-gray-900 mb-1">{title}</h3>
                <p className="text-sm text-gray-400 leading-relaxed">{desc}</p>
              </div>
            ))}
          </div>
          <p className="text-xs text-gray-400 mt-5">
            One unified pool per token. Isolated risk. Capital efficient. No oracles. No fragmentation.
          </p>
        </section>

        {/* GRADUATED TOKENS */}
        {graduated.length > 0 && (
          <section className="mb-16">
            <div className="flex items-center justify-between mb-5">
              <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Graduated Tokens</p>
              <span className="text-xs text-gray-400">{graduated.length} complete</span>
            </div>
            <div className="grid sm:grid-cols-2 gap-4">
              {graduated.map(token => (
                <Link key={token.id} href={`/token/${token.id}`}>
                  <div className="rounded-lg p-5 bg-white hover:shadow-sm transition-shadow">
                    <div className="flex items-center gap-3 mb-4">
                      <div className="relative w-10 h-10 rounded-md overflow-hidden bg-gray-100 flex-shrink-0">
                        <Image src={token.imageUrl} alt={token.name} fill className="object-cover" unoptimized />
                      </div>
                      <div className="min-w-0">
                        <p className="font-semibold text-sm text-gray-900 truncate">{token.name}</p>
                        <p className="text-xs text-gray-400">${token.ticker}</p>
                      </div>
                      <div className="ml-auto text-[10px] font-semibold px-2 py-0.5 rounded uppercase" style={{ background: "rgba(175,145,90,0.12)", color: "#8a7050" }}>
                        Raised
                      </div>
                    </div>
                    <div className="grid grid-cols-2 gap-y-2 text-xs">
                      <div>
                        <span className="text-gray-400">Raised</span>
                        <p className="font-semibold text-gray-900">{token.solRaised} SOL</p>
                      </div>
                      <div className="text-right">
                        <span className="text-gray-400">Target</span>
                        <p className="font-semibold text-gray-900">{token.targetSOL} SOL</p>
                      </div>
                      <div>
                        <span className="text-gray-400">Price</span>
                        <p className="font-semibold text-gray-900">{token.currentPrice.toFixed(7)}</p>
                      </div>
                      <div className="text-right">
                        <span className="text-gray-400">Creator Earned</span>
                        <p className="font-semibold" style={{ color: "#8a7050" }}>{token.creatorFeesEarned?.toFixed(3)} SOL</p>
                      </div>
                    </div>
                  </div>
                </Link>
              ))}
            </div>
          </section>
        )}

        {/* ALL LAUNCHES */}
        <section>
          <div className="flex items-center justify-between mb-4">
            <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider">All Launches</p>
            <Link href="/launches" className="text-sm font-medium transition-colors" style={{ color: "#8a7050" }}>
              See all →
            </Link>
          </div>
          <div className="rounded-lg overflow-hidden bg-white">
            {MOCK_TOKENS.map(token => (
              <TokenCard key={token.id} token={token} variant="list" />
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}
