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
import { GRADUATION_SOL, type Token } from "@/types";

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

/** Best-effort Token stubs from Supabase `select *` for first paint. */
function supabaseRowsToTokens(sbRows: unknown[], su: number | undefined): Token[] {
  const out: Token[] = [];
  for (const raw of sbRows) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const mint = typeof r.mint === "string" ? r.mint : "";
    if (!mint || isDemoMarketMint(mint)) continue;

    const solRaisedLamports = Number(r.sol_raised ?? 0);
    const solRaised =
      Number.isFinite(solRaisedLamports) && solRaisedLamports > 1e6
        ? solRaisedLamports / 1e9
        : Number.isFinite(solRaisedLamports)
          ? solRaisedLamports
          : 0;
    const totalSupplyRaw = Number(r.total_supply ?? 0);
    const totalSupply =
      Number.isFinite(totalSupplyRaw) && totalSupplyRaw > 1e9
        ? totalSupplyRaw / 1e6
        : Number.isFinite(totalSupplyRaw) && totalSupplyRaw > 0
          ? totalSupplyRaw
          : 1_000_000_000;
    const phaseRaw = typeof r.phase === "string" ? r.phase : "bonding";
    const phase =
      phaseRaw === "graduated" || phaseRaw === "ready_to_graduate"
        ? phaseRaw
        : "bonding";
    const currentPrice =
      typeof r.current_price === "number" && Number.isFinite(r.current_price)
        ? r.current_price
        : 0;

    const stub: Token = {
      id: mint,
      mint,
      name: typeof r.name === "string" && r.name ? r.name : "Token",
      ticker: typeof r.symbol === "string" && r.symbol ? r.symbol : "???",
      description: typeof r.description === "string" ? r.description : "",
      about: typeof r.about === "string" ? r.about : undefined,
      imageUrl: typeof r.image_url === "string" ? r.image_url : "",
      creator: typeof r.creator === "string" ? r.creator : "",
      creatorFeeRecipient:
        typeof r.creator_fee_recipient === "string" && r.creator_fee_recipient
          ? r.creator_fee_recipient
          : typeof r.creator === "string"
            ? r.creator
            : "",
      twitter: typeof r.twitter === "string" ? r.twitter : undefined,
      telegram: typeof r.telegram === "string" ? r.telegram : undefined,
      website: typeof r.website === "string" ? r.website : undefined,
      metadataUri: typeof r.uri === "string" ? r.uri : undefined,
      createdAt:
        typeof r.created_at === "string" ? new Date(r.created_at) : new Date(),
      phase,
      solRaised,
      targetSOL: GRADUATION_SOL,
      tokensSold:
        Number(r.tokens_sold ?? 0) > 1e6
          ? Number(r.tokens_sold) / 1e6
          : Number(r.tokens_sold ?? 0) || 0,
      totalSupply,
      currentPrice,
      marketCap:
        typeof r.market_cap === "number" && Number.isFinite(r.market_cap)
          ? r.market_cap
          : 0,
      launchPrice: 0,
      funders: typeof r.funders === "number" ? r.funders : 0,
      gammPool:
        typeof r.gamm_pool === "string" && r.gamm_pool ? r.gamm_pool : undefined,
    };
    out.push(applyTokenMarketCapUsd(stub, su));
  }
  return out;
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
        // Wave 1 — paint ASAP from sol price + Supabase (no getProgramAccounts / volume).
        const [solUsdJson, sbJson] = await Promise.all([
          fetch("/api/sol-usd").then(r => r.json()).catch(() => ({})),
          fetch("/api/tokens?limit=200").then(r => r.json()).catch(() => []),
        ]);
        if (cancelled) return;

        let su: number | undefined;
        if (typeof solUsdJson.solUsd === "number" && solUsdJson.solUsd > 0) {
          su = solUsdJson.solUsd;
        }
        setSolUsd(su ?? null);

        const sbRows = Array.isArray(sbJson) ? sbJson : [];
        const quick = supabaseRowsToTokens(sbRows, su);
        if (quick.length) {
          setTokens(prev => (prev?.length ? prev : quick));
        }

        // Wave 2 — on-chain truth + recent activity (parallel).
        const [chainList, recentJson, devRecentJson] = await Promise.all([
          fetchAllTokenStatesAsTokens(connection, su).catch(() => [] as Token[]),
          fetch("/api/trades/recent-activity")
            .then(r => r.json())
            .catch(() => ({ byMint: {} })),
          fetch("/dev-recent-activity.json")
            .then(r => (r.ok ? r.json() : {}))
            .catch(() => ({})),
        ]);
        if (cancelled) return;

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

        const byMint = supabaseTokensByMint(sbRows);
        const merged = (chainList.length ? chainList : quick)
          .filter(t => !isDemoMarketMint(t.mint))
          .map(t => mergeTokenMetadataFromSupabaseRow(t, byMint.get(t.mint)))
          .map(t => applyTokenMarketCapUsd(t, su));
        setTokens(merged);
        setExploreListCache({
          tokens: merged,
          vol24hLamportsByMint: {},
          solUsd: su ?? null,
        });

        void enrichTokensWithMetadata(merged, null).then(enriched => {
          if (!cancelled) {
            const next = enriched
              .filter(t => !isDemoMarketMint(t.mint))
              .map(t => applyTokenMarketCapUsd(t, su));
            setTokens(next);
          }
        });

        // Wave 3 — volumes never block the grid.
        void fetch("/api/trades/volume-24h")
          .then(r => r.json())
          .then(volJson => {
            if (cancelled) return;
            const vj = volJson as { byMint?: Record<string, string> };
            const by = vj.byMint && typeof vj.byMint === "object" ? vj.byMint : {};
            setVol24hLamportsByMint(by);
            setExploreListCache({
              tokens: merged,
              vol24hLamportsByMint: by,
              solUsd: su ?? null,
            });
          })
          .catch(() => {});
      } catch {
        if (!cancelled) setTokens(prev => prev ?? []);
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

  const sortedNew = useMemo(() => {
    const list = [...(tokens ?? [])].filter(t => !isDemoMarketMint(t.mint));
    list.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    return list;
  }, [tokens]);

  const sortedByMcap = useMemo(() => {
    const list = [...(tokens ?? [])].filter(t => !isDemoMarketMint(t.mint));
    list.sort((a, b) => b.marketCap - a.marketCap);
    return list;
  }, [tokens]);

  function filterByTab(tab: DirectoryTab, query: string): Token[] {
    const q = query.trim().toLowerCase();
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
