"use client";

import { useCallback, useEffect, useState, useRef } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync,
  getMint,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
} from "@solana/spl-token";

/** Default when mint is missing or unreadable. */
const DEFAULT_TOKEN_DECIMALS = 6;

export type WalletBalancesState = {
  /** SOL in lamports */
  solBalanceLamports: number;
  /** Token amount in smallest units (string for u64 safety) */
  tokenBalanceRaw: string;
  /** Mint decimals used for `tokenBalanceDisplay` and spendable math */
  tokenDecimals: number;
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
  const [tokenDecimals, setTokenDecimals] = useState(DEFAULT_TOKEN_DECIMALS);
  const [loading, setLoading] = useState(false);

  /** Always the latest wallet + mint (for stale async guard). */
  const currentWalletKeyRef = useRef<string | null>(null);
  const currentMintKeyRef = useRef<string | null>(null);
  currentWalletKeyRef.current = publicKey?.toBase58() ?? null;
  currentMintKeyRef.current = mintAddress ?? null;

  const prevWalletKeyRef = useRef<string | null>(null);
  useEffect(() => {
    const next = publicKey?.toBase58() ?? null;
    const prev = prevWalletKeyRef.current;
    prevWalletKeyRef.current = next;
    if (prev === next) return;
    console.log("[wallet] switch", {
      component: "useWalletBalances",
      prev,
      next,
      reset: "solLamports+tokenBalanceRaw+loading",
    });
    setSolBalanceLamports(0);
    setTokenBalanceRaw("0");
    setTokenDecimals(DEFAULT_TOKEN_DECIMALS);
    setLoading(true);
  }, [publicKey?.toBase58(), connected]);

  const refreshBalances = useCallback(async () => {
    if (!connected || !publicKey) {
      setSolBalanceLamports(0);
      setTokenBalanceRaw("0");
      setTokenDecimals(DEFAULT_TOKEN_DECIMALS);
      setLoading(false);
      return;
    }

    const startWallet = publicKey.toBase58();
    const startMint = mintAddress ?? null;

    setLoading(true);
    try {
      const sol = await connection.getBalance(publicKey, "confirmed");
      if (
        startWallet !== currentWalletKeyRef.current ||
        startMint !== currentMintKeyRef.current
      ) {
        console.log("[wallet] stale balance fetch ignored", {
          startWallet,
          currentWallet: currentWalletKeyRef.current,
          startMint,
          currentMint: currentMintKeyRef.current,
        });
        return;
      }
      setSolBalanceLamports(sol);

      if (!mintAddress) {
        setTokenBalanceRaw("0");
        setTokenDecimals(DEFAULT_TOKEN_DECIMALS);
        return;
      }

      let mint: PublicKey;
      try {
        mint = new PublicKey(mintAddress);
      } catch {
        setTokenBalanceRaw("0");
        setTokenDecimals(DEFAULT_TOKEN_DECIMALS);
        return;
      }

      const mintAcct = await connection.getAccountInfo(mint, "confirmed");
      const tokenProgram = mintAcct?.owner.equals(TOKEN_2022_PROGRAM_ID)
        ? TOKEN_2022_PROGRAM_ID
        : TOKEN_PROGRAM_ID;
      let decimals = DEFAULT_TOKEN_DECIMALS;
      try {
        const mintData = await getMint(connection, mint, "confirmed", tokenProgram);
        decimals = mintData.decimals;
      } catch {
        decimals = DEFAULT_TOKEN_DECIMALS;
      }
      if (
        startWallet !== currentWalletKeyRef.current ||
        startMint !== currentMintKeyRef.current
      ) {
        return;
      }
      setTokenDecimals(decimals);

      const ata = getAssociatedTokenAddressSync(
        mint,
        publicKey,
        false,
        tokenProgram
      );
      try {
        const { value } = await connection.getTokenAccountBalance(ata, "confirmed");
        if (
          startWallet !== currentWalletKeyRef.current ||
          startMint !== currentMintKeyRef.current
        ) {
          console.log("[wallet] stale token balance fetch ignored", {
            startWallet,
            currentWallet: currentWalletKeyRef.current,
          });
          return;
        }
        setTokenBalanceRaw(value.amount);
      } catch {
        if (
          startWallet !== currentWalletKeyRef.current ||
          startMint !== currentMintKeyRef.current
        ) {
          return;
        }
        setTokenBalanceRaw("0");
      }
    } finally {
      if (
        startWallet === currentWalletKeyRef.current &&
        startMint === currentMintKeyRef.current
      ) {
        setLoading(false);
      }
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

   const tokenUi = Number(tokenBalanceRaw) / 10 ** tokenDecimals;
  const tokenBalanceDisplay = Number.isFinite(tokenUi)
    ? tokenUi.toLocaleString(undefined, {
        minimumFractionDigits: 0,
        maximumFractionDigits: 4,
      })
    : "0";

  return {
    solBalanceLamports,
    tokenBalanceRaw,
    tokenDecimals,
    solBalanceDisplay,
    tokenBalanceDisplay,
    loading,
    refreshBalances,
  };
}
