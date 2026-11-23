"use client";

import { useConnection } from "@solana/wallet-adapter-react";
import { useEffect, useState } from "react";
import {
  getCachedSplMintHolders,
  type MintHolder,
} from "@/lib/tokenHolders";

export function useMintHolders(
  mint: string | undefined,
  enabled = true,
  excludeOwners: string[] = []
) {
  const { connection } = useConnection();
  const [holders, setHolders] = useState<MintHolder[]>([]);
  const [loading, setLoading] = useState(false);
  const excludeKey = excludeOwners.join(",");

  useEffect(() => {
    if (!enabled || !mint?.trim()) {
      setHolders([]);
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);

    void getCachedSplMintHolders(connection, mint.trim(), {
      decimals: 6,
      limit: 40,
      excludeOwners,
    })
      .then((rows) => {
        if (!cancelled) setHolders(rows);
      })
      .catch(() => {
        if (!cancelled) setHolders([]);
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

  return { holders, loading, count: holders.length };
}
