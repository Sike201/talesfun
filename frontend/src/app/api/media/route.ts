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

  const hit = await fetchIpfs(path);
  if (!hit) {
    return Response.json({ error: "Failed to load media" }, { status: 502 });
  }

  const contentType =
    hit.res.headers.get("content-type") || "application/octet-stream";
  const buf = await hit.res.arrayBuffer();

  return new Response(buf, {
    status: 200,
    headers: {
      "Content-Type": contentType,
      "Cache-Control": "public, max-age=86400, s-maxage=86400, immutable",
    },
  });
}
