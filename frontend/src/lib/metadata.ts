import type { Token } from "@/types";
import { resolveToHttps } from "@/lib/ipfs";

export { resolveToHttps } from "@/lib/ipfs";

/** Row shape from GET /api/tokens and public.tokens (snake_case). */
export type SupabaseTokenRow = {
  mint?: string;
  name?: string | null;
  symbol?: string | null;
  image_url?: string | null;
  description?: string | null;
  about?: string | null;
  uri?: string | null;
  twitter?: string | null;
  telegram?: string | null;
  website?: string | null;
};

export function supabaseTokensByMint(rows: unknown): Map<string, SupabaseTokenRow> {
  const m = new Map<string, SupabaseTokenRow>();
  if (!Array.isArray(rows)) return m;
  for (const r of rows) {
    if (r && typeof r === "object" && "mint" in r) {
      const mint = (r as { mint: unknown }).mint;
      if (typeof mint === "string" && mint.trim()) {
        m.set(mint.trim(), r as SupabaseTokenRow);
      }
    }
  }
  return m;
}

/**
 * Merge **metadata only** (name, image, socials, URI) from Supabase.
 * Never overwrites bonding state: phase, sol raised, reserves, or `gamm_pool` — those must come from `tokenStateToToken`.
 */
export function mergeTokenMetadataFromSupabaseRow(
  token: Token,
  row: SupabaseTokenRow | null | undefined
): Token {
  if (!row || typeof row !== "object") return token;
  const name =
    typeof row.name === "string" && row.name.trim() ? row.name.trim() : null;
  const symbol =
    typeof row.symbol === "string" && row.symbol.trim() ? row.symbol.trim() : null;
  const imageRaw =
    typeof row.image_url === "string" && row.image_url.trim()
      ? row.image_url.trim()
      : null;
  const imageUrl = imageRaw ? resolveToHttps(imageRaw) : token.imageUrl;
  const desc =
    typeof row.description === "string" && row.description.trim()
      ? row.description.trim()
      : null;
  const about =
    typeof row.about === "string" && row.about.trim()
      ? row.about.trim()
      : null;
  const twitter =
    typeof row.twitter === "string" && row.twitter.trim()
      ? row.twitter.trim()
      : null;
  const telegram =
    typeof row.telegram === "string" && row.telegram.trim()
      ? row.telegram.trim()
      : null;
  const website =
    typeof row.website === "string" && row.website.trim()
      ? row.website.trim()
      : null;
  const uri =
    typeof row.uri === "string" && row.uri.trim() ? row.uri.trim() : null;

  return {
    ...token,
    name: name ?? token.name,
    ticker: symbol ?? token.ticker,
    imageUrl: imageUrl || token.imageUrl,
    description: desc ?? about ?? token.description,
    about: about ?? desc ?? token.about ?? token.description,
    metadataUri: uri || token.metadataUri,
    twitter: twitter ?? token.twitter,
    telegram: telegram ?? token.telegram,
    website: website ?? token.website,
  };
}

/** True if we should hit `/api/metadata` (Pinata/IPFS) for missing image or body text. */
export function needsRemoteMetadataFetch(token: Token): boolean {
  const uri = token.metadataUri?.trim();
  if (!uri) return false;
  const hasImg = !!token.imageUrl?.trim();
  const hasText = !!(
    token.description?.trim() ||
    token.about?.trim()
  );
  return !hasImg || !hasText;
}

/** Metaplex-style off-chain JSON (Pinata / IPFS). */
export type MetaplexMetadataJson = {
  name?: string;
  symbol?: string;
  description?: string;
  image?: string;
  external_url?: string;
  attributes?: { trait_type?: string; value?: string | number }[];
};

export function enrichTokenFromMetaplexJson(
  token: Token,
  json: MetaplexMetadataJson
): Token {
  const description =
    typeof json.description === "string" ? json.description : token.description;
  let imageUrl = token.imageUrl;
  if (typeof json.image === "string" && json.image.trim()) {
    imageUrl = resolveToHttps(json.image);
  }

  let twitter = token.twitter;
  let telegram = token.telegram;
  let website = token.website;

  const attrs = Array.isArray(json.attributes) ? json.attributes : [];
  for (const a of attrs) {
    const trait = (a.trait_type || "").toLowerCase();
    const val = a.value != null ? String(a.value) : "";
    if (trait === "twitter" && val) twitter = val.replace(/^@/, "");
    if (trait === "telegram" && val) telegram = val;
    if (trait === "website" && val) website = val;
  }

  if (!website && typeof json.external_url === "string" && json.external_url.trim()) {
    website = json.external_url.trim();
  }

  return {
    ...token,
    name: typeof json.name === "string" && json.name.trim() ? json.name : token.name,
    ticker:
      typeof json.symbol === "string" && json.symbol.trim() ? json.symbol : token.ticker,
    description,
    about: description,
    imageUrl,
    twitter,
    telegram,
    website,
  };
}

/** Load Metaplex JSON from `token.metadataUri` via `/api/metadata` and merge into the token. */
export async function enrichTokenWithFetchedMetadata(token: Token): Promise<Token> {
  if (!needsRemoteMetadataFetch(token)) {
    console.log(
      "[metadata] skip remote URI (Supabase+chain sufficient)",
      token.mint.slice(0, 8) + "…"
    );
    return token;
  }
  const uri = token.metadataUri?.trim();
  if (!uri) return token;
  const t0 = performance.now();
  try {
    const res = await fetch(
      `/api/metadata?url=${encodeURIComponent(uri)}`
    );
    if (!res.ok) return token;
    const json = (await res.json()) as MetaplexMetadataJson;
    console.log(
      "[metadata] image/about from remote metadata URI",
      token.mint.slice(0, 8) + "…",
      `(${(performance.now() - t0).toFixed(0)}ms)`
    );
    return enrichTokenFromMetaplexJson(token, json);
  } catch {
    return token;
  }
}

/**
 * Merge optional Supabase rows, then fetch remote metadata only when fields are still missing.
 */
export async function enrichTokensWithMetadata(
  tokens: Token[],
  supabaseRows?: unknown[] | null
): Promise<Token[]> {
  const byMint =
    supabaseRows != null && supabaseRows.length > 0
      ? supabaseTokensByMint(supabaseRows)
      : null;
  const merged = byMint
    ? tokens.map(t => mergeTokenMetadataFromSupabaseRow(t, byMint.get(t.mint)))
    : tokens;
  let remoteSkips = 0;
  let remoteFetches = 0;
  const out = await Promise.all(
    merged.map(async t => {
      if (!needsRemoteMetadataFetch(t)) {
        remoteSkips++;
        return t;
      }
      remoteFetches++;
      return enrichTokenWithFetchedMetadata(t);
    })
  );
  console.log(
    "[metadata] batch enrich: remote fetch",
    remoteFetches,
    "skip",
    remoteSkips,
    "total",
    merged.length
  );
  return out;
}
