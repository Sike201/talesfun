"use client";

import Link from "next/link";
import { cn } from "@/lib/utils";
import { fraunces } from "@/lib/fonts";

const SECTIONS = [
  {
    title: "What is Tales?",
    body: "Tales is a launchpad for bonding-curve tokens that graduate into Omnipair markets — so every graduated token can be longed or shorted from day one.",
  },
  {
    title: "Launch",
    body: "Create a token, seed the curve, and raise toward the graduation threshold. Progress is tracked live on Explore as New → Interest → Migrated.",
  },
  {
    title: "Graduate",
    body: "At graduation, liquidity migrates into an Omnipair GAMM pool. That unlocks long, short, and borrow markets on the same asset.",
  },
  {
    title: "Trade",
    body: "Before graduation you trade the bonding curve. After graduation you trade (and hedge) through Omnipair. Charts and volume update from on-chain activity.",
  },
];

export default function DocsPage() {
  return (
    <div data-tales-page>
      <div className="mx-auto max-w-2xl px-6 pb-24 pt-10">
        <p className="mb-3 text-xs font-medium uppercase tracking-[0.14em] text-white/40">
          Docs
        </p>
        <h1
          className={cn(
            fraunces.className,
            "font-fraunces text-[2rem] font-medium tracking-tight text-white sm:text-[2.35rem]"
          )}
          style={{
            fontFamily:
              "var(--font-fraunces), Fraunces, ui-serif, Georgia, serif",
            fontVariationSettings: '"SOFT" 55, "WONK" 1, "opsz" 144',
            letterSpacing: "-0.03em",
          }}
        >
          How Tales works
        </h1>
        <p className="mt-4 text-[15px] leading-relaxed text-white/55">
          Short guide to launching, graduating, and trading on Tales.
        </p>

        <div className="mt-10 space-y-9">
          {SECTIONS.map(s => (
            <section key={s.title}>
              <h2 className="text-[15px] font-semibold text-white">{s.title}</h2>
              <p className="mt-2 text-[14px] leading-relaxed text-white/55">
                {s.body}
              </p>
            </section>
          ))}
        </div>

        <div className="mt-12 flex flex-wrap gap-3 border-t border-white/10 pt-8">
          <Link
            href="/create"
            className="rounded-full bg-[#c8e6ff] px-4 py-2 text-sm font-semibold text-[#120f17] transition-colors hover:bg-[#e0f1ff]"
          >
            Launch a token
          </Link>
          <Link
            href="/launches"
            className="rounded-full border border-white/20 px-4 py-2 text-sm font-semibold text-white/80 transition-colors hover:border-white/35 hover:bg-white/5"
          >
            Explore markets
          </Link>
          <a
            href="https://x.com/Talesdotfun"
            target="_blank"
            rel="noopener noreferrer"
            className="rounded-full border border-white/20 px-4 py-2 text-sm font-semibold text-white/80 transition-colors hover:border-white/35 hover:bg-white/5"
          >
            Follow on X
          </a>
        </div>
      </div>
    </div>
  );
}
