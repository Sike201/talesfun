export interface Token {
  id: string;
  mint: string;
  name: string;
  ticker: string;
  description: string;
  about?: string;
  imageUrl: string;
  creator: string;
  creatorFeeRecipient: string;
  twitter?: string;
  telegram?: string;
  website?: string;
  /** On-chain metadata JSON URI (Pinata / IPFS). Used to load image + description. */
  metadataUri?: string;
  createdAt: Date;

  phase: "bonding" | "ready_to_graduate" | "graduated";
  solRaised: number;
  targetSOL: number;
  tokensSold: number;
  /**
   * Bonding vault reserves from on-chain `TokenState` (SOL lamports / token raw 10^-6).
   * After Omnipair bootstrap these are 0 on-chain; Supabase may still show stale initial values.
   */
  chainRealSolReserveSol?: number;
  chainRealSolReserveLamports?: string;
  chainRealTokenReserveRaw?: string;
  /** Virtual AMM reserves (lamports / raw token) — required for exact bonding quotes. */
  chainVirtualSolLamports?: string;
  chainVirtualTokenReserveRaw?: string;
  totalSupply: number;
  currentPrice: number;
  marketCap: number;
  launchPrice: number;
  funders: number;

  gammPool?: string;
  creatorFeesEarned?: number;
  lpFeesEarned?: number;
  volume24h?: number;
}

export interface Trade {
  id: string;
  tokenMint: string;
  trader: string;
  type: "buy" | "sell";
  solAmount: number;
  tokenAmount: number;
  price: number;
  timestamp: Date;
  txSignature: string;
  /** Market venue; bonding rows omit or default to bonding. */
  source?: "bonding" | "omnipair";
}

export interface CreatorStats {
  totalFeesEarned: number;
  claimableSOL: number;
  tokens: Token[];
  trades: Trade[];
}

export const FIXED_SUPPLY = 1_000_000_000;

/** Display / progress target; must match deployed program threshold. Default 85 (prod). Set `NEXT_PUBLIC_GRADUATION_SOL=0.5` when using a `dev-graduation` program build. */
export const GRADUATION_SOL: number = (() => {
  const raw = process.env.NEXT_PUBLIC_GRADUATION_SOL;
  if (raw != null && raw !== "") {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 85;
})();

/**
 * SOL reserved/budgeted for Omnipair pair creation at bootstrap.
 * Protocol fee is ~0.2 SOL; we budget 0.25 SOL headroom (+ rent paid by deployer).
 */
export const OMNIPAIR_PAIR_FEE_SOL: number = (() => {
  const raw = process.env.NEXT_PUBLIC_OMNIPAIR_PAIR_FEE_SOL;
  if (raw != null && raw !== "") {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 0.25;
})();
/** Creator fee removed — kept at 0 for legacy quote helpers. */
export const CREATOR_FEE_BPS = 0;
/** Bonding-curve fee that stays in the vault as liquidity (1%). */
export const LP_FEE_BPS = 100;
/** Total bonding-curve fee (1%). Omnipair market swap fee is separate (30 bps). */
export const TOTAL_FEE_BPS = 100;
/** Omnipair / Dusk base swap fee when opening a graduated market. */
export const OMNIPAIR_SWAP_FEE_BPS = 30;
export const PROGRAM_ID = "72bwK5ffBy2vRTu694L8WtQ6xaXYA8ePJtxB34fnV2wv";
