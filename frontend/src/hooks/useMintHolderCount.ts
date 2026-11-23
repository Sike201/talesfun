"use client";

import { useConnection } from "@solana/wallet-adapter-react";
import { useEffect, useState } from "react";
import { getCachedSplMintHolderCount } from "@/lib/tokenHolderCount";

export function useMintHolderCount(
  mint: string | undefined,
  enabled = true,
  excludeOwners: string[] = []
) {
  const { connection } = useConnection();
  const [count, setCount] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const excludeKey = excludeOwners.join(",");

  useEffect(() => {
    if (!enabled || !mint?.trim()) {
      setCount(null);
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setCount(null);

    void getCachedSplMintHolderCount(connection, mint.trim(), {
      excludeOwners,
    })
      .then((n) => {
        if (!cancelled) setCount(n);
      })
      .catch(() => {
        if (!cancelled) setCount(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
    // excludeKey captures excludeOwners content without referential churn
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connection, mint, enabled, excludeKey]);

  return { count, loading };
}
