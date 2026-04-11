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
  createdAt: Date;

  phase: "bonding" | "graduated";
  solRaised: number;
  targetSOL: number;
  tokensSold: number;
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
}

export interface CreatorStats {
  totalFeesEarned: number;
  claimableSOL: number;
  tokens: Token[];
  trades: Trade[];
}

export const FIXED_SUPPLY = 1_000_000_000;
export const GRADUATION_SOL = 85;
export const CREATOR_FEE_BPS = 50;
export const LP_FEE_BPS = 50;
export const TOTAL_FEE_BPS = 100;
export const PROGRAM_ID = "72bwK5ffBy2vRTu694L8WtQ6xaXYA8ePJtxB34fnV2wv";
