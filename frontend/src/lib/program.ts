import { Program, AnchorProvider, BN } from "@coral-xyz/anchor";
import { Connection, PublicKey } from "@solana/web3.js";
import type { AnchorWallet } from "@solana/wallet-adapter-react";
import idl from "./idl/higher_launchpad.json";
import { type Token, GRADUATION_SOL } from "@/types";
import { OMNIPAIR_PROGRAM_ID_STR } from "./omnipairProgram";

export const PROGRAM_ID = new PublicKey(
  process.env.NEXT_PUBLIC_PROGRAM_ID ||
    "72bwK5ffBy2vRTu694L8WtQ6xaXYA8ePJtxB34fnV2wv"
);

/** Re-exported from `omnipairProgram.ts` (`NEXT_PUBLIC_OMNIPAIR_PROGRAM_ID` / `OMNIPAIR_PROGRAM_ID`). */
export { OMNIPAIR_PROGRAM_ID_STR };

/** True when on-chain `token_state.gamm_pool` is set to a non-default pubkey (real pair address). */
export function hasRealOmnipairPoolOnChain(
  token: Pick<Token, "phase" | "gammPool">
): boolean {
  if (token.phase !== "graduated") return false;
  const p = token.gammPool?.trim();
  if (!p) return false;
  return p !== PublicKey.default.toBase58();
}

const METADATA_PROGRAM_ID = new PublicKey(
  "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s"
);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type HigherProgram = Program<any>;

export function getProgram(
  wallet: AnchorWallet,
  connection: Connection
): HigherProgram {
  const provider = new AnchorProvider(connection, wallet, {
    commitment: "confirmed",
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new Program(idl as any, provider);
}

export function getReadOnlyProgram(connection: Connection): HigherProgram {
  const dummyWallet = {
    publicKey: PublicKey.default,
    signTransaction: async <T,>(tx: T) => tx,
    signAllTransactions: async <T,>(txs: T[]) => txs,
  } as AnchorWallet;
  const provider = new AnchorProvider(connection, dummyWallet, {
    commitment: "confirmed",
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new Program(idl as any, provider);
}

// ── PDA helpers ──────────────────────────────────────────────────────────────

export function getPlatformPDA(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("platform")],
    PROGRAM_ID
  );
}

export function getTokenStatePDA(mint: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("token_state"), mint.toBuffer()],
    PROGRAM_ID
  );
}

export function getSolVaultPDA(mint: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("sol_vault"), mint.toBuffer()],
    PROGRAM_ID
  );
}

export function getMintAuthorityPDA(mint: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("mint_authority"), mint.toBuffer()],
    PROGRAM_ID
  );
}

export function getFeeEscrowPDA(mint: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("fee_escrow"), mint.toBuffer()],
    PROGRAM_ID
  );
}

export function getMetadataPDA(mint: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("metadata"),
      METADATA_PROGRAM_ID.toBuffer(),
      mint.toBuffer(),
    ],
    METADATA_PROGRAM_ID
  );
  return pda;
}

// ── On-chain → frontend type conversion ──────────────────────────────────────

/** Optional SOL/USD for market-cap USD only; token price stays on-chain (`currentPrice` in SOL). */
export type TokenStateToTokenOptions = {
  solUsd?: number | null;
};

const FALLBACK_SOL_USD = 140;

/** Anchor `tokenState.phase` → Supabase / app phase string (matches `tokenStateToToken`). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function chainPhaseLabelFromTokenState(state: any): "bonding" | "ready_to_graduate" | "graduated" {
  if (state?.phase?.graduated != null) return "graduated";
  if (state?.phase?.readyToGraduate != null) return "ready_to_graduate";
  return "bonding";
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function tokenStateToToken(
  state: any,
  mintAddress: string,
  options?: TokenStateToTokenOptions
): Token {
  const vSol = state.virtualSolReserve.toNumber();
  const vToken = state.virtualTokenReserve.toNumber();
  // price = (vSol / 1e9) / (vToken / 1e6)  →  SOL per 1 UI token
  const currentPrice = vToken > 0 ? vSol / (vToken * 1000) : 0;
  const solRaised = state.solRaised.toNumber() / 1e9;

  const usdMult =
    options?.solUsd != null && Number.isFinite(options.solUsd) && options.solUsd > 0
      ? options.solUsd
      : FALLBACK_SOL_USD;

  const phase = chainPhaseLabelFromTokenState(state);

  const uri =
    typeof state.uri === "string" ? state.uri.trim() : "";

  const realSol = state.realSolReserve?.toNumber?.() ?? 0;
  const realTok = state.realTokenReserve?.toNumber?.() ?? 0;
  const vSolBn = state.virtualSolReserve;
  const vTokBn = state.virtualTokenReserve;
  return {
    id: mintAddress,
    mint: mintAddress,
    name: state.name,
    ticker: state.symbol,
    description: "",
    imageUrl: "",
    metadataUri: uri || undefined,
    creator: state.creator.toBase58(),
    creatorFeeRecipient: state.creatorFeeRecipient.toBase58(),
    createdAt: new Date(state.createdAt.toNumber() * 1000),
    phase,
    solRaised,
    targetSOL: GRADUATION_SOL,
    tokensSold: state.tokensSold.toNumber() / 1e6,
    totalSupply: state.totalSupply.toNumber() / 1e6,
    currentPrice,
    marketCap: currentPrice * (state.totalSupply.toNumber() / 1e6) * usdMult,
    launchPrice: 30_000_000_000 / (1_073_000_191_000_000 * 1000),
    funders: 0,
    chainRealSolReserveSol: realSol / 1e9,
    chainRealSolReserveLamports: state.realSolReserve?.toString?.() ?? "0",
    chainRealTokenReserveRaw: String(realTok),
    chainVirtualSolLamports: vSolBn?.toString?.() ?? "0",
    chainVirtualTokenReserveRaw: vTokBn?.toString?.() ?? "0",
    gammPool: state.gammPool.toBase58() === PublicKey.default.toBase58()
      ? undefined
      : state.gammPool.toBase58(),
    creatorFeesEarned: state.creatorFeesAccumulated.toNumber() / 1e9,
  };
}

/** Mint + real Omnipair pair — from chain only (for indexers; ignores stale DB). */
export type GraduatedOmnipairMint = {
  mint: string;
  gammPool: string;
};

/**
 * Graduated tokens with a non-default `gamm_pool` (Omnipair already linked).
 * Use this instead of Supabase `tokens.phase` / `gamm_pool` for indexing GAMM swaps.
 */
export async function fetchGraduatedOmnipairMintsFromChain(
  connection: Connection
): Promise<GraduatedOmnipairMint[]> {
  const ro = getReadOnlyProgram(connection);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const all = (await (ro.account as any).tokenState.all()) as {
    account: { mint: PublicKey; gammPool: PublicKey } & Record<string, unknown>;
  }[];
  const out: GraduatedOmnipairMint[] = [];
  for (const row of all) {
    const acc = row.account;
    const phase = chainPhaseLabelFromTokenState(acc);
    if (phase !== "graduated") continue;
    const gamm = acc.gammPool;
    if (gamm.equals(PublicKey.default)) continue;
    out.push({ mint: acc.mint.toBase58(), gammPool: gamm.toBase58() });
  }
  return out;
}

export type MintNeedingBootstrap = { mint: string; symbol: string };

/**
 * Graduated but Omnipair not bootstrapped yet (`gamm_pool` still default on-chain).
 * Symbol comes from `TokenState` — no Supabase dependency.
 */
export async function fetchMintRecordsNeedingOmnipairBootstrap(
  connection: Connection
): Promise<MintNeedingBootstrap[]> {
  const ro = getReadOnlyProgram(connection);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const all = (await (ro.account as any).tokenState.all()) as {
    account: {
      mint: PublicKey;
      gammPool: PublicKey;
      symbol: string;
    } & Record<string, unknown>;
  }[];
  const out: MintNeedingBootstrap[] = [];
  for (const row of all) {
    const acc = row.account;
    const phase = chainPhaseLabelFromTokenState(acc);
    if (phase !== "graduated") continue;
    if (!acc.gammPool.equals(PublicKey.default)) continue;
    const sym =
      typeof acc.symbol === "string" && acc.symbol.trim()
        ? acc.symbol.trim()
        : "TKN";
    out.push({ mint: acc.mint.toBase58(), symbol: sym });
  }
  return out;
}

/** Recompute USD market cap from on-chain price × supply × SOL/USD (or fallback). */
export function applyTokenMarketCapUsd(
  token: Token,
  solUsd: number | null | undefined
): Token {
  const usdMult =
    solUsd != null && Number.isFinite(solUsd) && solUsd > 0
      ? solUsd
      : FALLBACK_SOL_USD;
  return {
    ...token,
    marketCap: token.currentPrice * token.totalSupply * usdMult,
  };
}

/** All on-chain token states, newest first (for home / explore). */
export async function fetchAllTokenStatesAsTokens(
  connection: Connection,
  solUsd?: number | null
): Promise<Token[]> {
  const ro = getReadOnlyProgram(connection);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const all = (await (ro.account as any).tokenState.all()) as {
    account: { mint: PublicKey } & Record<string, unknown>;
  }[];
  const opts: TokenStateToTokenOptions | undefined =
    solUsd != null && solUsd > 0 ? { solUsd } : undefined;
  const mapped = all.map((row) =>
    tokenStateToToken(row.account, row.account.mint.toBase58(), opts)
  );
  mapped.sort((a: Token, b: Token) => b.createdAt.getTime() - a.createdAt.getTime());
  return mapped;
}

// ── Bonding curve math (mirrors the Rust) ────────────────────────────────────

export function calculateTokensOut(
  virtualSol: BN,
  virtualTokens: BN,
  solIn: BN
): BN {
  const k = virtualSol.mul(virtualTokens);
  const newSol = virtualSol.add(solIn);
  const newTokens = k.div(newSol);
  return virtualTokens.sub(newTokens);
}

export function calculateSolOut(
  virtualSol: BN,
  virtualTokens: BN,
  tokensIn: BN
): BN {
  const k = virtualSol.mul(virtualTokens);
  const newTokens = virtualTokens.add(tokensIn);
  const newSol = k.div(newTokens);
  return virtualSol.sub(newSol);
}
