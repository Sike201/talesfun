import type { Token } from "@/types";

/** Metaplex-style off-chain JSON (Pinata / IPFS). */
export type MetaplexMetadataJson = {
  name?: string;
  symbol?: string;
  description?: string;
  image?: string;
  external_url?: string;
  attributes?: { trait_type?: string; value?: string | number }[];
};

/** Turn ipfs:// or bare CID paths into an https gateway URL for display / next/image. */
export function resolveToHttps(uri: string): string {
  const t = uri.trim();
  if (!t) return "";
  if (t.startsWith("ipfs://")) {
    const path = t.replace(/^ipfs:\/\//i, "").replace(/^ipfs\//i, "");
    return `https://gateway.pinata.cloud/ipfs/${path}`;
  }
  return t;
}

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
  const uri = token.metadataUri?.trim();
  if (!uri) return token;
  try {
    const res = await fetch(
      `/api/metadata?url=${encodeURIComponent(uri)}`
    );
    if (!res.ok) return token;
    const json = (await res.json()) as MetaplexMetadataJson;
    return enrichTokenFromMetaplexJson(token, json);
  } catch {
    return token;
  }
}

export async function enrichTokensWithMetadata(tokens: Token[]): Promise<Token[]> {
  return Promise.all(tokens.map(t => enrichTokenWithFetchedMetadata(t)));
}
