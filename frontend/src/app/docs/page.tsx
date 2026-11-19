"use client";

import Link from "next/link";
import { GRADUATION_SOL } from "@/types";

const PAIR_FEE_SOL = Number(
  process.env.NEXT_PUBLIC_OMNIPAIR_PAIR_FEE_SOL || "0.25"
);

const SECTIONS = [
  {
    title: "What is Tales?",
    body: "Tales is a launchpad for bonding-curve tokens that graduate into Omnipair markets, so every graduated token can be longed, shorted, or borrowed against from day one.",
  },
  {
    title: "Launch & bond",
    body: `Create a token and raise SOL on the curve. Devnet testing currently graduates at ${GRADUATION_SOL} SOL. Explore tracks markets as New → Interest → Migrated.`,
  },
  {
    title: "Graduation & Omnipair market",
    body: `When the curve hits ${GRADUATION_SOL} SOL, mint authority is revoked and the token is ready for Omnipair. Bootstrap moves vault liquidity into a GAMM pool. Keep at least ~${PAIR_FEE_SOL} SOL available for Omnipair pair creation (protocol fee is ~0.2 SOL plus rent; we budget ${PAIR_FEE_SOL} SOL as headroom). At ${GRADUATION_SOL} SOL that reserve is ${((PAIR_FEE_SOL / GRADUATION_SOL) * 100).toFixed(1)}% of the raise.`,
  },
  {
    title: "Trade after graduation",
    body: "Spot swaps use the Omnipair pool. Long, short, and borrow use Omnipair collateral + debt positions against the same pair. See Omnipair developer docs for instruction details.",
  },
];

export default function DocsPage() {
  return (
    <div data-tales-page className="min-h-screen bg-[#0a0a0a]">
      <div className="mx-auto max-w-2xl px-6 pb-16 pt-10">
        <p className="mb-3 text-[12px] font-medium uppercase tracking-[0.14em] text-white/35">
          Docs
        </p>
        <h1 className="text-[1.75rem] font-semibold tracking-[-0.03em] text-white sm:text-[2rem]">
          How Tales works
        </h1>
        <p className="mt-4 text-[15px] leading-relaxed text-white/50">
          Launch on a bonding curve, graduate into Omnipair, then long, short, or
          borrow the same market.
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

        <div className="mt-10 rounded-2xl border border-white/10 bg-white/[0.03] p-5">
          <p className="text-[13px] font-semibold text-white">Developer links</p>
          <ul className="mt-3 space-y-2 text-[13px] text-white/60">
            <li>
              <a
                className="text-[#c8e6ff] hover:underline"
                href="https://docs.omnipair.fi/developers/overview"
                target="_blank"
                rel="noopener noreferrer"
              >
                Omnipair developer overview
              </a>
            </li>
            <li>
              <a
                className="text-[#c8e6ff] hover:underline"
                href="https://docs.omnipair.fi/developers/sdk"
                target="_blank"
                rel="noopener noreferrer"
              >
                Omnipair TypeScript SDK
              </a>
            </li>
            <li>
              <a
                className="text-[#c8e6ff] hover:underline"
                href="https://docs.omnipair.fi/use-cases/leveraging"
                target="_blank"
                rel="noopener noreferrer"
              >
                Leveraging (long / short)
              </a>
            </li>
            <li>
              <a
                className="text-[#c8e6ff] hover:underline"
                href="https://docs.omnipair.fi/use-cases/borrowing"
                target="_blank"
                rel="noopener noreferrer"
              >
                Borrowing
              </a>
            </li>
            <li>
              <a
                className="text-[#c8e6ff] hover:underline"
                href="https://github.com/omnipair"
                target="_blank"
                rel="noopener noreferrer"
              >
                Omnipair on GitHub
              </a>
            </li>
          </ul>
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
