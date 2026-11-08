import { NextRequest } from "next/server";
import {
  extractIpfsPath,
  isAllowedIpfsFetchUrl,
  pinataDedicatedGatewayHost,
} from "@/lib/ipfs";

export const runtime = "nodejs";

async function fetchJson(url: string, headers?: HeadersInit) {
  const res = await fetch(url, {
    headers: { Accept: "application/json", ...headers },
    cache: "no-store",
  });
  if (!res.ok) return null;
  return (await res.json()) as unknown;
}

export async function GET(request: NextRequest) {
  const raw = request.nextUrl.searchParams.get("url");
  if (!raw) {
    return Response.json({ error: "Missing url query parameter" }, { status: 400 });
  }

  const path = extractIpfsPath(raw);
  if (!path && !isAllowedIpfsFetchUrl(raw)) {
    return Response.json({ error: "URL not allowed for metadata fetch" }, { status: 400 });
  }

  const jwt = process.env.PINATA_JWT?.trim();
  const attempts: { url: string; headers?: HeadersInit }[] = [];

  if (path) {
    const dedicated = `https://${pinataDedicatedGatewayHost()}/ipfs/${path}`;
    if (jwt) {
      attempts.push({
        url: dedicated,
        headers: { Authorization: `Bearer ${jwt}` },
      });
      attempts.push({
        url: dedicated,
        headers: { "x-pinata-gateway-token": jwt },
      });
    }
    attempts.push({ url: dedicated });
    attempts.push({ url: `https://gateway.pinata.cloud/ipfs/${path}` });
    attempts.push({ url: `https://ipfs.io/ipfs/${path}` });
  } else if (raw.trim()) {
    attempts.push({ url: raw.trim() });
  }

  for (const a of attempts) {
    try {
      const json = await fetchJson(a.url, a.headers);
      if (json && typeof json === "object") {
        return Response.json(json);
      }
    } catch {
      /* try next */
    }
  }

  return Response.json({ error: "Failed to load metadata" }, { status: 502 });
}
