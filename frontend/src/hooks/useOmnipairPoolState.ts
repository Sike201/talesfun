"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import {
  fetchOmnipairPoolSnapshot,
  type OmnipairPoolSnapshot,
} from "@/lib/omnipairPoolState";

const POLL_MS = 20_000;

export type UseOmnipairPoolStateResult = {
  snapshot: OmnipairPoolSnapshot | null;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
};

/**
 * Polls Omnipair Pair + vault balances when `enabled` and `pairAddress` are set.
 */
export function useOmnipairPoolState(params: {
  pairAddress: string | null | undefined;
  projectMint: string | null | undefined;
  enabled: boolean;
}): UseOmnipairPoolStateResult {
  const { connection } = useConnection();
  const { publicKey } = useWallet();
  const [snapshot, setSnapshot] = useState<OmnipairPoolSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);

  const pairAddress = params.pairAddress?.trim() || null;
  const projectMint = params.projectMint?.trim() || null;
  const enabled = params.enabled && !!pairAddress && !!projectMint;

  const refresh = useCallback(async () => {
    if (!enabled || !pairAddress || !projectMint) {
      setSnapshot(null);
      setError(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    const res = await fetchOmnipairPoolSnapshot(
      connection,
      pairAddress,
      projectMint,
      publicKey ?? null
    );
    if (!mounted.current) return;
    if (res.ok) {
      setSnapshot(res.data);
      setError(null);
    } else {
      setSnapshot(null);
      setError(res.message);
    }
    setLoading(false);
  }, [connection, enabled, pairAddress, projectMint, publicKey]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!enabled) return;
    const t = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(t);
  }, [enabled, refresh]);

  useEffect(() => {
    const onTrade = () => void refresh();
    if (typeof window === "undefined") return;
    window.addEventListener("higher:trade-complete", onTrade);
    return () => window.removeEventListener("higher:trade-complete", onTrade);
  }, [refresh]);

  return { snapshot, loading, error, refresh };
}
