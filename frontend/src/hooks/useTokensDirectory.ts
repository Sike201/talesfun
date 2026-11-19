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
import { DEMO_TOKEN } from "@/lib/demoMarket";
import type { Token } from "@/types";

export type DirectoryTab = "trending" | "graduated" | "new";

export function useTokensDirectory() {
  const { connection } = useConnection();
  const [tokens, setTokens] = useState<Token[] | null>(null);
  const [solUsd, setSolUsd] = useState<number | null>(null);
  const [vol24hLamportsByMint, setVol24hLamportsByMint] = useState<Record<string, string>>({});
  const [lastTradeByMint, setLastTradeByMint] = useState<
    Record<string, { timestamp: string; signature?: string; side?: string }>
  >({});

  useEffect(() => {
    const cached = takeExploreListCacheIfFresh();
    if (cached) {
      setTokens(cached.tokens);
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
        setVol24hLamportsByMint(vj.byMint && typeof vj.byMint === "object" ? vj.byMint : {});

        const apiRecent =
          recentJson?.byMint && typeof recentJson.byMint === "object"
            ? (recentJson.byMint as Record<string, { timestamp: string }>)
            : {};
        const devRecent =
          devRecentJson && typeof devRecentJson === "object"
            ? (devRecentJson as Record<string, { timestamp: string }>)
            : {};
        const localRecent = readLocalTradeActivity();
        const mergedRecent: Record<string, { timestamp: string }> = { ...devRecent, ...apiRecent };
        for (const [m, row] of Object.entries(localRecent)) {
          const prev = mergedRecent[m];
          if (!prev || new Date(row.timestamp).getTime() > new Date(prev.timestamp).getTime()) {
            mergedRecent[m] = { timestamp: row.timestamp };
          }
        }
        setLastTradeByMint(mergedRecent);

        const sbRows = Array.isArray(sbJson) ? sbJson : [];
        const byMint = supabaseTokensByMint(sbRows);
        const merged = (chainList ?? [])
          .map(t => mergeTokenMetadataFromSupabaseRow(t, byMint.get(t.mint)))
          .map(t => applyTokenMarketCapUsd(t, su));
        setTokens(merged);
        setExploreListCache({ tokens: merged, vol24hLamportsByMint: vj.byMint ?? {}, solUsd: su ?? null });

        void enrichTokensWithMetadata(merged, null).then(enriched => {
          if (!cancelled) {
            const next = enriched.map(t => applyTokenMarketCapUsd(t, su));
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
          const p = next[m];
          if (!p || new Date(row.timestamp).getTime() > new Date(p.timestamp).getTime()) {
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

  const sortedTrending = useMemo(() => {
    const base = tokens ?? [];
    const list = base.some(t => t.mint === DEMO_TOKEN.mint)
      ? [...base]
      : [DEMO_TOKEN, ...base];
    list.sort((a, b) => {
      if (a.mint === DEMO_TOKEN.mint) return -1;
      if (b.mint === DEMO_TOKEN.mint) return 1;
      const ta = lastTradeByMint[a.mint]?.timestamp
        ? new Date(lastTradeByMint[a.mint]!.timestamp).getTime()
        : 0;
      const tb = lastTradeByMint[b.mint]?.timestamp
        ? new Date(lastTradeByMint[b.mint]!.timestamp).getTime()
        : 0;
      if (ta !== tb) return tb - ta;
      const va = volLamports(a.mint);
      const vb = volLamports(b.mint);
      if (va !== vb) return va > vb ? -1 : 1;
      return b.marketCap - a.marketCap;
    });
    return list;
  }, [tokens, lastTradeByMint, vol24hLamportsByMint]);

  function filterByTab(tab: DirectoryTab, query: string): Token[] {
    const q = query.trim().toLowerCase();
    let list = sortedTrending;
    if (tab === "graduated") list = list.filter(t => t.phase === "graduated");
    else if (tab === "new")
      list = list.filter(t => t.phase === "bonding" || t.phase === "ready_to_graduate");
    if (q) {
      list = list.filter(
        t => t.name.toLowerCase().includes(q) || t.ticker.toLowerCase().includes(q)
      );
    }
    return list;
  }

  return {
    tokens,
    solUsd,
    vol24hLamportsByMint,
    lastTradeByMint,
    sortedTrending,
    filterByTab,
    loading: tokens === null,
  };
}