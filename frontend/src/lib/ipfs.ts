/** Extract CID (+ optional path) from ipfs:// or common gateway URLs. */
export function extractIpfsPath(uri: string): string | null {
  const t = uri.trim();
  if (!t) return null;
  if (t.startsWith("ipfs://")) {
    return t.replace(/^ipfs:\/\//i, "").replace(/^ipfs\//i, "");
  }
  try {
    const u = new URL(t);
    const m = u.pathname.match(/\/ipfs\/(.+)$/i);
    if (m?.[1]) return m[1];
  } catch {
    /* ignore */
  }
  return null;
}

export function pinataDedicatedGatewayHost(): string {
  const domain =
    process.env.PINATA_GATEWAY_DOMAIN?.trim() || "gray-electric-tarsier-54";
  return `${domain}.mypinata.cloud`;
}

/** Preferred public URL for a CID (dedicated Pinata gateway when available). */
export function ipfsHttpsUrl(cidOrPath: string): string {
  const path = cidOrPath.replace(/^\//, "");
  if (typeof window === "undefined") {
    return `https://${pinataDedicatedGatewayHost()}/ipfs/${path}`;
  }
  // Browser: go through our proxy so restricted gateways stay authenticated
  return `/api/media?cid=${encodeURIComponent(path)}`;
}

/** Turn ipfs:// or gateway URLs into a displayable https / proxy URL. */
export function resolveToHttps(uri: string): string {
  const t = uri.trim();
  if (!t) return "";
  const path = extractIpfsPath(t);
  if (path) return ipfsHttpsUrl(path);
  return t;
}

export function isAllowedIpfsFetchUrl(href: string): boolean {
  try {
    const u = new URL(href);
    if (u.protocol !== "https:" && u.protocol !== "http:") return false;
    const host = u.hostname.toLowerCase();
    const path = u.pathname;
    if (host === "gateway.pinata.cloud" && path.startsWith("/ipfs/")) return true;
    if (host.endsWith(".mypinata.cloud") && path.includes("/ipfs")) return true;
    if (host === "cloudflare-ipfs.com" && path.includes("/ipfs/")) return true;
    if (host === "ipfs.io" && path.startsWith("/ipfs/")) return true;
    if (host === "dweb.link" && path.startsWith("/ipfs/")) return true;
    if (host.endsWith(".nftstorage.link")) return true;
    if (host === "arweave.net") return true;
    return false;
  } catch {
    return false;
  }
}
