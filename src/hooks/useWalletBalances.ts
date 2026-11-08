"use client";

import { useCallback, useEffect, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";

/** SPL token decimals — matches launchpad mint (see program `TOKEN_DECIMALS`). */
const TOKEN_DECIMALS = 6;

export type WalletBalancesState = {
  /** SOL in lamports */
  solBalanceLamports: number;
  /** Token amount in smallest units (string for u64 safety) */
  tokenBalanceRaw: string;
  solBalanceDisplay: string;
  tokenBalanceDisplay: string;
  loading: boolean;
  refreshBalances: () => Promise<void>;
};

/**
 * Reads wallet SOL + ATA balance for `mintAddress` using the wallet adapter connection
 * (same RPC as `ConnectionProvider`, typically `NEXT_PUBLIC_SOLANA_RPC_URL` or devnet).
 */
export function useWalletBalances(mintAddress: string | undefined): WalletBalancesState {
  const { connection } = useConnection();
  const { publicKey, connected } = useWallet();
  const [solBalanceLamports, setSolBalanceLamports] = useState(0);
  const [tokenBalanceRaw, setTokenBalanceRaw] = useState("0");
  const [loading, setLoading] = useState(false);

  const refreshBalances = useCallback(async () => {
    if (!connected || !publicKey) {
      setSolBalanceLamports(0);
      setTokenBalanceRaw("0");
      setLoading(false);
      return;
    }

    setLoading(true);
    try {
      const sol = await connection.getBalance(publicKey, "confirmed");
      setSolBalanceLamports(sol);

      if (!mintAddress) {
        setTokenBalanceRaw("0");
        return;
      }

      let mint: PublicKey;
      try {
        mint = new PublicKey(mintAddress);
      } catch {
        setTokenBalanceRaw("0");
        return;
      }

      const ata = getAssociatedTokenAddressSync(mint, publicKey, false);
      try {
        const { value } = await connection.getTokenAccountBalance(ata, "confirmed");
        setTokenBalanceRaw(value.amount);
      } catch {
        setTokenBalanceRaw("0");
      }
    } finally {
      setLoading(false);
    }
  }, [connection, connected, publicKey, mintAddress]);

  useEffect(() => {
    void refreshBalances();
  }, [refreshBalances]);

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ mint?: string }>).detail;
      if (detail?.mint && mintAddress && detail.mint === mintAddress) {
        void refreshBalances();
      }
    };
    if (typeof window === "undefined") return;
    window.addEventListener("higher:trade-complete", handler);
    return () => window.removeEventListener("higher:trade-complete", handler);
  }, [mintAddress, refreshBalances]);

  const solBalanceDisplay = (solBalanceLamports / 1e9).toLocaleString(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: 6,
  });

  const tokenUi = Number(tokenBalanceRaw) / 10 ** TOKEN_DECIMALS;
  const tokenBalanceDisplay = Number.isFinite(tokenUi)
    ? tokenUi.toLocaleString(undefined, {
        minimumFractionDigits: 0,
        maximumFractionDigits: 4,
      })
    : "0";

  return {
    solBalanceLamports,
    tokenBalanceRaw,
    solBalanceDisplay,
    tokenBalanceDisplay,
    loading,
    refreshBalances,
  };
}
