import { Program, AnchorProvider, BN } from "@coral-xyz/anchor";
import { Connection, PublicKey } from "@solana/web3.js";
import type { AnchorWallet } from "@solana/wallet-adapter-react";
import { NATIVE_MINT } from "@solana/spl-token";
import { IDL as OmnipairIdl } from "@omnipair/program-interface";
import type { Omnipair } from "@omnipair/program-interface";
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import {
  OMNIPAIR_PROGRAM_ID,
  deriveOmnipairReserveVault,
} from "./omnipairProgram";

function getReadOnlyOmnipairProgram(connection: Connection): Program<Omnipair> {
  const dummyWallet = {
    publicKey: PublicKey.default,
    signTransaction: async <T,>(tx: T) => tx,
    signAllTransactions: async <T,>(txs: T[]) => txs,
  } as AnchorWallet;
  const omnipairIdlForCluster = {
    ...OmnipairIdl,
    address: OMNIPAIR_PROGRAM_ID.toBase58(),
  };
  return new Program(
    omnipairIdlForCluster as Omnipair,
    new AnchorProvider(connection, dummyWallet, { commitment: "confirmed" })
  );
}

function bnToBigInt(v: BN | bigint | number | { toString: () => string }): bigint {
  if (typeof v === "bigint") return v;
  if (typeof v === "number") return BigInt(Math.trunc(v));
  return BigInt(v.toString());
}

export type OmnipairPoolSnapshot = {
  pair: PublicKey;
  token0: PublicKey;
  token1: PublicKey;
  lpMint: PublicKey;
  projectMint: PublicKey;
  /** 0 = project is token0, 1 = project is token1 */
  projectSide: 0 | 1;
  vaultProject: PublicKey;
  vaultSol: PublicKey;
  /** Reserve vault balance, project mint (smallest units) */
  reserveProjectRaw: string;
  /** WSOL vault balance (smallest units, 9 decimals) */
  reserveSolRaw: string;
  projectTokenDecimals: number;
  solDecimals: number;
  /** On-chain Pair account cached reserves (same ordering as token0/token1) */
  pairReserve0: bigint;
  pairReserve1: bigint;
  lpMintSupplyRaw: string;
  lpDecimals: number;
  walletLpBalanceRaw: string;
  /** SOL per 1 UI token */
  spotPriceSol: number;
  token0Decimals: number;
  token1Decimals: number;
};

export type FetchOmnipairPoolSnapshotResult =
  | { ok: true; data: OmnipairPoolSnapshot }
  | { ok: false; message: string };

/**
 * Read Pair + reserve vault balances + LP supply + optional wallet LP balance.
 * `projectMint` must match either `pair.token0` or `pair.token1`.
 */
export async function fetchOmnipairPoolSnapshot(
  connection: Connection,
  pairAddress: string,
  projectMintAddress: string,
  walletPubkey: PublicKey | null
): Promise<FetchOmnipairPoolSnapshotResult> {
  let pairPk: PublicKey;
  let projectPk: PublicKey;
  try {
    pairPk = new PublicKey(pairAddress);
    projectPk = new PublicKey(projectMintAddress);
  } catch {
    return { ok: false, message: "Invalid pair or mint address" };
  }

  try {
    const program = getReadOnlyOmnipairProgram(connection);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pair = await (program.account as any).pair.fetch(pairPk);

    const token0 = pair.token0 as PublicKey;
    const token1 = pair.token1 as PublicKey;
    const lpMint = pair.lpMint as PublicKey;
    const d0 = Number(pair.token0Decimals);
    const d1 = Number(pair.token1Decimals);

    const isProj0 = token0.equals(projectPk);
    const isProj1 = token1.equals(projectPk);
    if (!isProj0 && !isProj1) {
      return {
        ok: false,
        message: "Pair does not include this token mint",
      };
    }

    const isSol0 = token0.equals(NATIVE_MINT);
    const isSol1 = token1.equals(NATIVE_MINT);
    if (!isSol0 && !isSol1) {
      return {
        ok: false,
        message: "Pair is not a SOL (WSOL) market",
      };
    }

    const projectSide: 0 | 1 = isProj0 ? 0 : 1;
    const solSide: 0 | 1 = isSol0 ? 0 : 1;

    const [vault0] = deriveOmnipairReserveVault(pairPk, token0);
    const [vault1] = deriveOmnipairReserveVault(pairPk, token1);

    const [bal0, bal1] = await Promise.all([
      connection.getTokenAccountBalance(vault0, "confirmed").catch(() => null),
      connection.getTokenAccountBalance(vault1, "confirmed").catch(() => null),
    ]);

    if (!bal0?.value || !bal1?.value) {
      return {
        ok: false,
        message: "Could not read reserve vault token balances",
      };
    }

    const reserveProjectRaw =
      projectSide === 0 ? bal0.value.amount : bal1.value.amount;
    const reserveSolRaw = solSide === 0 ? bal0.value.amount : bal1.value.amount;

    const r0 = bnToBigInt(pair.reserve0);
    const r1 = bnToBigInt(pair.reserve1);

    let lpSupply = "0";
    let lpDecimals = 6;
    try {
      const sup = await connection.getTokenSupply(lpMint, "confirmed");
      lpSupply = sup.value.amount;
      lpDecimals = sup.value.decimals;
    } catch {
      lpSupply = "0";
      lpDecimals = 6;
    }

    let walletLp = "0";
    if (walletPubkey) {
      const lpAta = getAssociatedTokenAddressSync(
        lpMint,
        walletPubkey,
        false,
        TOKEN_PROGRAM_ID
      );
      try {
        const w = await connection.getTokenAccountBalance(lpAta, "confirmed");
        walletLp = w.value.amount;
      } catch {
        walletLp = "0";
      }
    }

    const projectTokenDecimals = projectSide === 0 ? d0 : d1;
    const solDecimals = solSide === 0 ? d0 : d1;
    const projUi = Number(reserveProjectRaw) / 10 ** projectTokenDecimals;
    const solUi = Number(reserveSolRaw) / 10 ** solDecimals;
    const spotPriceSol =
      projUi > 0 && Number.isFinite(solUi / projUi) ? solUi / projUi : 0;

    return {
      ok: true,
      data: {
        pair: pairPk,
        token0,
        token1,
        lpMint,
        projectMint: projectPk,
        projectSide,
        vaultProject: projectSide === 0 ? vault0 : vault1,
        vaultSol: solSide === 0 ? vault0 : vault1,
        reserveProjectRaw,
        reserveSolRaw,
        projectTokenDecimals,
        solDecimals,
        pairReserve0: r0,
        pairReserve1: r1,
        lpMintSupplyRaw: lpSupply,
        lpDecimals,
        walletLpBalanceRaw: walletLp,
        spotPriceSol,
        token0Decimals: d0,
        token1Decimals: d1,
      },
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      message: msg || "Failed to load Omnipair pair",
    };
  }
}
