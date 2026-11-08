"use client";

import { useMemo } from "react";
import { useConnection } from "@solana/wallet-adapter-react";
import { useAnchorWallet } from "@solana/wallet-adapter-react";
import { getProgram, type HigherProgram } from "@/lib/program";

export function useProgram(): HigherProgram | null {
  const { connection } = useConnection();
  const wallet = useAnchorWallet();

  return useMemo(() => {
    if (!wallet) return null;
    return getProgram(wallet, connection);
  }, [wallet, connection]);
}
