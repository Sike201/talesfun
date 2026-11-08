"use client";

import { useEffect, useState } from "react";

const CLIENT_TTL_MS = 45_000;

let clientCache: { value: number | null; at: number } | null = null;

export type UseSolUsdResult = {
  solUsd: number | null;
  loading: boolean;
};

/**
 * SOL/USD for UI only (Dexscreener). Does not affect on-chain token price.
 * Cached briefly in memory on the client.
 */
export function useSolUsd(): UseSolUsdResult {
  const [solUsd, setSolUsd] = useState<number | null>(() =>
    clientCache && Date.now() - clientCache.at < CLIENT_TTL_MS ? clientCache.value : null
  );
  const [loading, setLoading] = useState(!clientCache || Date.now() - clientCache.at >= CLIENT_TTL_MS);

  useEffect(() => {
    const now = Date.now();
    if (clientCache && now - clientCache.at < CLIENT_TTL_MS) {
      setSolUsd(clientCache.value);
      setLoading(false);
      return;
    }

    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const res = await fetch("/api/sol-usd");
        const data = (await res.json()) as { solUsd?: number | null };
        const v =
          data.solUsd != null && Number.isFinite(data.solUsd) && data.solUsd > 0
            ? data.solUsd
            : null;
        clientCache = { value: v, at: Date.now() };
        if (!cancelled) setSolUsd(v);
      } catch {
        clientCache = { value: null, at: Date.now() };
        if (!cancelled) setSolUsd(null);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  return { solUsd, loading };
}
