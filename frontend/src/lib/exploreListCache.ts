import type { Token } from "@/types";

/** In-memory list for fast Home → Explore client navigation (not SSR). */
export type ExploreListCache = {
  tokens: Token[];
  vol24hLamportsByMint: Record<string, string>;
  solUsd: number | null;
  updatedAt: number;
};

const TTL_MS = 120_000;

let cache: ExploreListCache | null = null;

export function setExploreListCache(entry: {
  tokens: Token[];
  vol24hLamportsByMint: Record<string, string>;
  solUsd: number | null;
}): void {
  cache = {
    tokens: entry.tokens,
    vol24hLamportsByMint: entry.vol24hLamportsByMint,
    solUsd: entry.solUsd,
    updatedAt: Date.now(),
  };
}

/** Fresh-enough snapshot for instant Explore paint after visiting Home. */
export function takeExploreListCacheIfFresh(): ExploreListCache | null {
  if (!cache) return null;
  if (Date.now() - cache.updatedAt > TTL_MS) return null;
  return cache;
}
