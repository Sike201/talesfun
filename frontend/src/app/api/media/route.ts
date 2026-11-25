import { NextRequest } from "next/server";
import {
  extractIpfsPath,
  isAllowedIpfsFetchUrl,
  pinataDedicatedGatewayHost,
} from "@/lib/ipfs";

export const runtime = "nodejs";

async function fetchIpfs(
  path: string
): Promise<{ res: Response; url: string } | null> {
  const jwt = process.env.PINATA_JWT?.trim();
  const dedicated = `https://${pinataDedicatedGatewayHost()}/ipfs/${path}`;
  const candidates: { url: string; headers?: HeadersInit }[] = [
    {
      url: dedicated,
      headers: jwt
        ? { Authorization: `Bearer ${jwt}`, Accept: "*/*" }
        : { Accept: "*/*" },
    },
    {
      url: dedicated,
      headers: jwt
        ? { "x-pinata-gateway-token": jwt, Accept: "*/*" }
        : { Accept: "*/*" },
    },
    { url: `https://gateway.pinata.cloud/ipfs/${path}`, headers: { Accept: "*/*" } },
    { url: `https://ipfs.io/ipfs/${path}`, headers: { Accept: "*/*" } },
    { url: `https://dweb.link/ipfs/${path}`, headers: { Accept: "*/*" } },
  ];

  for (const c of candidates) {
    try {
      const res = await fetch(c.url, {
        headers: c.headers,
        cache: "force-cache",
      });
      if (res.ok) return { res, url: c.url };
    } catch {
      /* try next */
    }
  }
  return null;
}

/** Proxy IPFS media through the dedicated Pinata gateway (avoids public 429s). */
export async function GET(request: NextRequest) {
  const cidParam = request.nextUrl.searchParams.get("cid");
  const rawUrl = request.nextUrl.searchParams.get("url");

  let path = cidParam?.trim() || null;
  if (!path && rawUrl) {
    if (!isAllowedIpfsFetchUrl(rawUrl) && !extractIpfsPath(rawUrl)) {
      return Response.json({ error: "URL not allowed" }, { status: 400 });
    }
    path = extractIpfsPath(rawUrl);
  }

  if (!path) {
    return Response.json({ error: "Missing cid or url" }, { status: 400 });
  }

  // Fast path: redirect to the dedicated gateway so the browser hits CDN directly.
  const jwt = process.env.PINATA_JWT?.trim();
  const dedicated = `https://${pinataDedicatedGatewayHost()}/ipfs/${path}`;
  if (!jwt) {
    return Response.redirect(dedicated, 302);
  }

  const hit = await fetchIpfs(path);
  if (!hit) {
    // Last resort: still send the browser to the public dedicated URL.
    return Response.redirect(dedicated, 302);
  }

  const contentType =
    hit.res.headers.get("content-type") || "application/octet-stream";
  // Stream when possible — avoid buffering full image on the edge.
  return new Response(hit.res.body, {
    status: 200,
    headers: {
      "Content-Type": contentType,
      "Cache-Control": "public, max-age=86400, s-maxage=604800, immutable",
      "CDN-Cache-Control": "public, s-maxage=604800, immutable",
    },
  });
}
