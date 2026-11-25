import { extractIpfsPath, pinataDedicatedGatewayHost, resolveToHttps } from "@/lib/ipfs";

/**
 * Prefer the dedicated Pinata gateway in the browser (CDN, no app-server hop).
 * Fall back to /api/media only when we have no gateway domain.
 */
export function tokenMediaSrc(raw?: string): string | undefined {
  const t = raw?.trim();
  if (!t) return undefined;
  const path = extractIpfsPath(t);
  if (path) {
    const domain =
      typeof process !== "undefined"
        ? process.env.NEXT_PUBLIC_PINATA_GATEWAY_DOMAIN?.trim() ||
          process.env.PINATA_GATEWAY_DOMAIN?.trim()
        : undefined;
    // Public dedicated gateway is usually enough for pinned launch art.
    const host = domain
      ? `${domain}.mypinata.cloud`
      : pinataDedicatedGatewayHost();
    return `https://${host}/ipfs/${path}`;
  }
  return resolveToHttps(t) || undefined;
}
