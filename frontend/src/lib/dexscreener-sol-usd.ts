/** Native wrapped SOL (WSOL) mint on Solana. */
export const WSOL_MINT = "So11111111111111111111111111111111111111112";

/** USDC mint on Solana (Dexscreener pairs use this for SOL/USDC). */
export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

type DexToken = { address?: string; symbol?: string };

export type DexScreenerPair = {
  chainId?: string;
  dexId?: string;
  baseToken?: DexToken;
  quoteToken?: DexToken;
  priceUsd?: string;
  liquidity?: { usd?: number };
};

type DexScreenerTokenResponse = {
  pairs?: DexScreenerPair[];
};

/**
 * Pick best SOL/USDC (WSOL base, USDC quote) pair on Solana by `liquidity.usd`.
 * `priceUsd` is the base (SOL) price in USD per Dexscreener.
 */
export function pickBestSolUsdcPriceUsd(pairs: DexScreenerPair[]): number | null {
  const solanaWsolUsdc = pairs.filter(p => {
    if (p.chainId !== "solana") return false;
    const b = p.baseToken?.address;
    const q = p.quoteToken?.address;
    return b === WSOL_MINT && q === USDC_MINT;
  });
  if (solanaWsolUsdc.length === 0) return null;
  solanaWsolUsdc.sort(
    (a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0)
  );
  const top = solanaWsolUsdc[0];
  const raw = top.priceUsd;
  if (raw == null || raw === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Fetch SOL/USD from Dexscreener WSOL token endpoint. */
export async function fetchSolUsdFromDexscreener(): Promise<number | null> {
  const url = `https://api.dexscreener.com/latest/dex/tokens/${WSOL_MINT}`;
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) return null;
  const json = (await res.json()) as DexScreenerTokenResponse;
  const pairs = Array.isArray(json.pairs) ? json.pairs : [];
  return pickBestSolUsdcPriceUsd(pairs);
}
