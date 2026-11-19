"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { LayoutGroup, motion } from "framer-motion";
import { cn } from "@/lib/utils";
import {
  type DirectoryTab,
  useTokensDirectory,
} from "@/hooks/useTokensDirectory";
import LaunchpadTokenCard from "@/components/markets/LaunchpadTokenCard";

const TABS: { id: DirectoryTab | "near"; label: string }[] = [
  { id: "trending", label: "Trending" },
  { id: "new", label: "New" },
  { id: "near", label: "Near graduation" },
  { id: "graduated", label: "Graduated" },
];

const PAGE_SIZE = 30;

const positionSpring = {
  type: "spring" as const,
  stiffness: 480,
  damping: 18,
  mass: 0.7,
};

export default function TokensDirectory({ initialQuery = "" }: { initialQuery?: string }) {
  const searchParams = useSearchParams();
  const queryParam = searchParams.get("q") ?? initialQuery;
  const [tab, setTab] = useState<DirectoryTab | "near">("trending");
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const { sortedTrending, filterByTab, loading } = useTokensDirectory();

  const list = useMemo(() => {
    if (tab === "near") {
      const q = queryParam.trim().toLowerCase();
      return sortedTrending.filter(t => {
        if (t.phase !== "ready_to_graduate" && t.phase !== "bonding") return false;
        if (t.phase === "bonding") {
          const p = t.targetSOL > 0 ? (t.solRaised / t.targetSOL) * 100 : 0;
          if (p < 70) return false;
        }
        if (!q) return true;
        return (
          t.name.toLowerCase().includes(q) || t.ticker.toLowerCase().includes(q)
        );
      });
    }
    return filterByTab(tab, queryParam);
  }, [tab, queryParam, filterByTab, sortedTrending]);

  useEffect(() => {
    setVisibleCount(PAGE_SIZE);
  }, [tab, queryParam]);

  const topTokens = useMemo(
    () => sortedTrending.slice(0, 4),
    [sortedTrending]
  );

  const visible = useMemo(
    () => list.slice(0, visibleCount),
    [list, visibleCount]
  );
  const hasMore = list.length > visibleCount;

  return (
    <div data-tales-page className="min-h-screen bg-[#0a0a0a]">
      <div className="mx-auto w-full max-w-6xl px-4 pb-4 pt-10 sm:px-6 md:px-8">
        <div className="flex flex-col gap-6 sm:flex-row sm:items-end sm:justify-between">
          <div className="max-w-xl">
            <h1 className="text-[1.75rem] font-semibold tracking-[-0.03em] text-white sm:text-[2rem]">
              Explore launches
            </h1>
            <p className="mt-2 text-[14px] leading-relaxed text-white/40">
              Bonding curves that graduate into Omnipair. Long or short any graduated token.
            </p>
          </div>
          <Link
            href="/create"
            className="inline-flex h-10 shrink-0 items-center justify-center rounded-full bg-white px-5 text-[13px] font-semibold text-[#0a0a0a] transition-opacity hover:opacity-90"
          >
            Launch a token
          </Link>
        </div>

        {topTokens.length > 0 ? (
          <section className="mt-12">
            <h2 className="mb-4 text-[12px] font-medium uppercase tracking-[0.14em] text-white/35">
              Top tokens
            </h2>
            <LayoutGroup id="top-tokens">
              <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
                {topTokens.map(t => (
                  <motion.div
                    key={t.mint}
                    layout
                    layoutId={`top-${t.mint}`}
                    transition={positionSpring}
                    className="min-w-0"
                  >
                    <LaunchpadTokenCard token={t} featured />
                  </motion.div>
                ))}
              </div>
            </LayoutGroup>
          </section>
        ) : null}

        <section id="markets" className="mt-12">
          <div className="flex flex-wrap gap-1">
            {TABS.map(t => (
              <button
                key={t.id}
                type="button"
                onClick={() => setTab(t.id)}
                className={cn(
                  "rounded-full px-3.5 py-1.5 text-[13px] font-medium transition-colors",
                  tab === t.id
                    ? "bg-white/[0.1] text-white"
                    : "text-white/40 hover:text-white/75"
                )}
              >
                {t.label}
              </button>
            ))}
          </div>

          {loading && list.length === 0 ? (
            <div className="mt-6 grid grid-cols-2 gap-x-3 gap-y-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
              {Array.from({ length: 10 }).map((_, i) => (
                <div
                  key={i}
                  className="animate-pulse overflow-hidden rounded-xl border border-white/[0.06]"
                >
                  <div className="aspect-square bg-white/[0.04]" />
                  <div className="space-y-2 border-t border-white/[0.05] px-2.5 py-2.5">
                    <div className="h-3 w-2/3 rounded-sm bg-white/[0.06]" />
                    <div className="h-3 w-1/3 rounded-sm bg-white/[0.04]" />
                  </div>
                </div>
              ))}
            </div>
          ) : list.length === 0 ? (
            <div className="mt-16 text-center">
              <p className="text-sm text-white/35">No launches in this view.</p>
              <Link
                href="/create"
                className="mt-3 inline-flex text-[13px] font-medium text-white/70 underline-offset-4 hover:underline"
              >
                Launch one
              </Link>
            </div>
          ) : (
            <>
              <LayoutGroup id="token-grid">
                <div className="mt-6 grid grid-cols-2 gap-x-3 gap-y-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
                  {visible.map(token => (
                    <motion.div
                      key={token.mint}
                      layout
                      layoutId={`grid-${token.mint}`}
                      transition={positionSpring}
                      className="min-w-0"
                    >
                      <LaunchpadTokenCard token={token} />
                    </motion.div>
                  ))}
                </div>
              </LayoutGroup>

              {hasMore ? (
                <div className="mt-8 flex justify-center">
                  <button
                    type="button"
                    onClick={() =>
                      setVisibleCount(c => Math.min(c + PAGE_SIZE, list.length))
                    }
                    className="inline-flex h-10 items-center rounded-full border border-white/[0.12] px-5 text-[13px] font-medium text-white/70 transition-colors hover:border-white/20 hover:text-white"
                  >
                    Show more
                  </button>
                </div>
              ) : null}
            </>
          )}
        </section>
      </div>
    </div>
  );
}
