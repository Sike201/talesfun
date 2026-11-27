"use client";

import { useConnection } from "@solana/wallet-adapter-react";
import { useEffect, useMemo, useState } from "react";
import {
  applyTokenMarketCapUsd,
  fetchAllTokenStatesAsTokens,
} from "@/lib/program";
import {
  enrichTokensWithMetadata,
  mergeTokenMetadataFromSupabaseRow,
  supabaseTokensByMint,
} from "@/lib/metadata";
import { setExploreListCache, takeExploreListCacheIfFresh } from "@/lib/exploreListCache";
import { readLocalTradeActivity } from "@/lib/recentActivityLocal";
import { isDemoMarketMint } from "@/lib/demoMarket";
import type { Token } from "@/types";

export type DirectoryTab =
  | "trending"
  | "new"
  | "near"
  | "graduated"
  | "mcap";

function bondingProgressPct(t: Token): number {
  if (t.phase === "ready_to_graduate" || t.phase === "graduated") return 100;
  if (!(t.targetSOL > 0)) return 0;
  return (t.solRaised / t.targetSOL) * 100;
}

function lastTradeMs(
  mint: string,
  lastTradeByMint: Record<string, { timestamp: string }>
): number {
  const ts = lastTradeByMint[mint]?.timestamp;
  if (!ts) return 0;
  const n = new Date(ts).getTime();
  return Number.isFinite(n) ? n : 0;
}

export function useTokensDirectory() {
  const { connection } = useConnection();
  const [tokens, setTokens] = useState<Token[] | null>(null);
  const [solUsd, setSolUsd] = useState<number | null>(null);
  const [vol24hLamportsByMint, setVol24hLamportsByMint] = useState<
    Record<string, string>
  >({});
  const [lastTradeByMint, setLastTradeByMint] = useState<
    Record<string, { timestamp: string; signature?: string; side?: string }>
  >({});

  useEffect(() => {
    const cached = takeExploreListCacheIfFresh();
    if (cached) {
      // Never resurrect the old Aether demo from a stale client cache.
      const cleaned = cached.tokens.filter(t => !isDemoMarketMint(t.mint));
      setTokens(cleaned);
      setSolUsd(cached.solUsd);
      setVol24hLamportsByMint(cached.vol24hLamportsByMint);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const [solUsdJson, sbJson, chainList, volJson, recentJson, devRecentJson] =
          await Promise.all([
            fetch("/api/sol-usd").then(r => r.json()).catch(() => ({})),
            fetch("/api/tokens?limit=200").then(r => r.json()).catch(() => []),
            fetchAllTokenStatesAsTokens(connection, undefined).catch(() => []),
            fetch("/api/trades/volume-24h").then(r => r.json()).catch(() => ({})),
            fetch("/api/trades/recent-activity")
              .then(r => r.json())
              .catch(() => ({ byMint: {} })),
            fetch("/dev-recent-activity.json")
              .then(r => (r.ok ? r.json() : {}))
              .catch(() => ({})),
          ]);
        if (cancelled) return;

        let su: number | undefined;
        if (typeof solUsdJson.solUsd === "number" && solUsdJson.solUsd > 0) {
          su = solUsdJson.solUsd;
        }
        setSolUsd(su ?? null);

        const vj = volJson as { byMint?: Record<string, string> };
        setVol24hLamportsByMint(
          vj.byMint && typeof vj.byMint === "object" ? vj.byMint : {}
        );

        const apiRecent =
          recentJson?.byMint && typeof recentJson.byMint === "object"
            ? (recentJson.byMint as Record<string, { timestamp: string }>)
            : {};
        const devRecent =
          devRecentJson && typeof devRecentJson === "object"
            ? (devRecentJson as Record<string, { timestamp: string }>)
            : {};
        const localRecent = readLocalTradeActivity();
        const mergedRecent: Record<string, { timestamp: string }> = {
          ...devRecent,
          ...apiRecent,
        };
        for (const [m, row] of Object.entries(localRecent)) {
          if (isDemoMarketMint(m)) continue;
          const prev = mergedRecent[m];
          if (
            !prev ||
            new Date(row.timestamp).getTime() > new Date(prev.timestamp).getTime()
          ) {
            mergedRecent[m] = { timestamp: row.timestamp };
          }
        }
        setLastTradeByMint(mergedRecent);

        const sbRows = Array.isArray(sbJson) ? sbJson : [];
        const byMint = supabaseTokensByMint(sbRows);
        const merged = (chainList ?? [])
          .filter(t => !isDemoMarketMint(t.mint))
          .map(t => mergeTokenMetadataFromSupabaseRow(t, byMint.get(t.mint)))
          .map(t => applyTokenMarketCapUsd(t, su));
        setTokens(merged);
        setExploreListCache({
          tokens: merged,
          vol24hLamportsByMint: vj.byMint ?? {},
          solUsd: su ?? null,
        });

        void enrichTokensWithMetadata(merged, null).then(enriched => {
          if (!cancelled) {
            const next = enriched
              .filter(t => !isDemoMarketMint(t.mint))
              .map(t => applyTokenMarketCapUsd(t, su));
            setTokens(next);
            setExploreListCache({
              tokens: next,
              vol24hLamportsByMint: vj.byMint ?? {},
              solUsd: su ?? null,
            });
          }
        });
      } catch {
        if (!cancelled) setTokens([]);
      }
    })();

    const onRecent = () => {
      const localRecent = readLocalTradeActivity();
      setLastTradeByMint(prev => {
        const next = { ...prev };
        for (const [m, row] of Object.entries(localRecent)) {
          if (isDemoMarketMint(m)) continue;
          const p = next[m];
          if (
            !p ||
            new Date(row.timestamp).getTime() > new Date(p.timestamp).getTime()
          ) {
            next[m] = { timestamp: row.timestamp };
          }
        }
        return next;
      });
    };
    window.addEventListener("tales:recent-activity", onRecent);
    return () => {
      cancelled = true;
      window.removeEventListener("tales:recent-activity", onRecent);
    };
  }, [connection]);

  const volLamports = (mint: string) => BigInt(vol24hLamportsByMint[mint] ?? "0");

  /** Trending = most recently traded, then 24h volume, then mcap. */
  const sortedTrending = useMemo(() => {
    const list = [...(tokens ?? [])].filter(t => !isDemoMarketMint(t.mint));
    list.sort((a, b) => {
      const ta = lastTradeMs(a.mint, lastTradeByMint);
      const tb = lastTradeMs(b.mint, lastTradeByMint);
      if (ta !== tb) return tb - ta;
      const va = volLamports(a.mint);
      const vb = volLamports(b.mint);
      if (va !== vb) return va > vb ? -1 : 1;
      return b.marketCap - a.marketCap;
    });
    return list;
  }, [tokens, lastTradeByMint, vol24hLamportsByMint]);

  /** New = most recently created (any phase). */
  const sortedNew = useMemo(() => {
    const list = [...(tokens ?? [])].filter(t => !isDemoMarketMint(t.mint));
    list.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    return list;
  }, [tokens]);

  /** Market cap = highest USD mcap first (any phase). */
  const sortedByMcap = useMemo(() => {
    const list = [...(tokens ?? [])].filter(t => !isDemoMarketMint(t.mint));
    list.sort((a, b) => b.marketCap - a.marketCap);
    return list;
  }, [tokens]);

  function filterByTab(tab: DirectoryTab, query: string): Token[] {
    const q = query.trim().toLowerCase();
    // Search is global: name / ticker / mint (partial), not limited to the active tab.
    if (q) {
      const list = [...(tokens ?? [])].filter(t => !isDemoMarketMint(t.mint));
      const matched = list.filter(
        t =>
          t.name.toLowerCase().includes(q) ||
          t.ticker.toLowerCase().includes(q) ||
          t.mint.toLowerCase().includes(q)
      );
      matched.sort((a, b) => {
        const aExact = a.mint.toLowerCase() === q ? 1 : 0;
        const bExact = b.mint.toLowerCase() === q ? 1 : 0;
        if (aExact !== bExact) return bExact - aExact;
        const aPref =
          a.mint.toLowerCase().startsWith(q) ||
          a.ticker.toLowerCase().startsWith(q) ||
          a.name.toLowerCase().startsWith(q)
            ? 1
            : 0;
        const bPref =
          b.mint.toLowerCase().startsWith(q) ||
          b.ticker.toLowerCase().startsWith(q) ||
          b.name.toLowerCase().startsWith(q)
            ? 1
            : 0;
        if (aPref !== bPref) return bPref - aPref;
        return b.marketCap - a.marketCap;
      });
      return matched;
    }

    switch (tab) {
      case "trending":
        return sortedTrending;
      case "new":
        return sortedNew;
      case "near":
        return sortedNew.filter(t => {
          if (t.phase === "graduated") return false;
          if (t.phase === "ready_to_graduate") return true;
          return bondingProgressPct(t) >= 75;
        });
      case "graduated":
        return sortedTrending.filter(t => t.phase === "graduated");
      case "mcap":
        return sortedByMcap;
      default:
        return sortedTrending;
    }
  }

  return {
    tokens,
    solUsd,
    vol24hLamportsByMint,
    lastTradeByMint,
    sortedTrending,
    sortedNew,
    sortedByMcap,
    filterByTab,
    loading: tokens === null,
  };
}
