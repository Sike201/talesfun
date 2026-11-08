import { fetchSolUsdFromDexscreener } from "@/lib/dexscreener-sol-usd";

export const dynamic = "force-dynamic";

const TTL_MS = 45_000;

let cache: { value: number | null; fetchedAt: number } | null = null;

export async function GET() {
  const now = Date.now();
  if (cache && now - cache.fetchedAt < TTL_MS) {
    return Response.json({ solUsd: cache.value });
  }
  try {
    const value = await fetchSolUsdFromDexscreener();
    cache = { value, fetchedAt: now };
    return Response.json({ solUsd: value });
  } catch {
    cache = { value: null, fetchedAt: now };
    return Response.json({ solUsd: null });
  }
}
