import { Connection, PublicKey } from "@solana/web3.js";

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
  pairReserve0: bigint;
  pairReserve1: bigint;
  lpMintSupplyRaw: string;
  lpDecimals: number;
  walletLpBalanceRaw: string;
  /** Mid price in SOL per whole project token (vault ratio). */
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
  try {
    // Validate addresses early for clearer errors.
    // eslint-disable-next-line no-new
    new PublicKey(pairAddress);
    // eslint-disable-next-line no-new
    new PublicKey(projectMintAddress);
  } catch {
    return { ok: false, message: "Invalid pair or mint address" };
  }

  try {
    const { fetchDuskPoolSnapshot } = await import("./duskMarket");
    return await fetchDuskPoolSnapshot(
      connection,
      pairAddress,
      projectMintAddress,
      walletPubkey
    );
  } catch (error: unknown) {
    return {
      ok: false,
      message:
        error instanceof Error ? error.message : "Could not read the Dusk market",
    };
  }
}
