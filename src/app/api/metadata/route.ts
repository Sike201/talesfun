import { NextRequest } from "next/server";

function toFetchableUrl(raw: string): string | null {
  const t = raw.trim();
  if (!t) return null;
  if (t.startsWith("ipfs://")) {
    const path = t.replace(/^ipfs:\/\//i, "").replace(/^ipfs\//i, "");
    return `https://gateway.pinata.cloud/ipfs/${path}`;
  }
  try {
    const u = new URL(t);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.href;
  } catch {
    return null;
  }
}

/** Avoid open redirects / SSRF: only fetch from known IPFS gateways and Arweave. */
function isAllowedFetchUrl(href: string): boolean {
  try {
    const u = new URL(href);
    if (u.protocol !== "https:" && u.protocol !== "http:") return false;
    const host = u.hostname.toLowerCase();
    const path = u.pathname;
    if (host === "gateway.pinata.cloud" && path.startsWith("/ipfs/")) return true;
    if (host === "cloudflare-ipfs.com" && path.includes("/ipfs/")) return true;
    if (host === "ipfs.io" && path.startsWith("/ipfs/")) return true;
    if (host.endsWith(".mypinata.cloud") && path.includes("/ipfs")) return true;
    if (host === "arweave.net") return true;
    return false;
  } catch {
    return false;
  }
}

export async function GET(request: NextRequest) {
  const raw = request.nextUrl.searchParams.get("url");
  if (!raw) {
    return Response.json({ error: "Missing url query parameter" }, { status: 400 });
  }

  const fetchable = toFetchableUrl(raw);
  if (!fetchable || !isAllowedFetchUrl(fetchable)) {
    return Response.json({ error: "URL not allowed for metadata fetch" }, { status: 400 });
  }

  try {
    const res = await fetch(fetchable, {
      headers: { Accept: "application/json" },
      cache: "no-store",
    });
    if (!res.ok) {
      return Response.json(
        { error: "Failed to load metadata", status: res.status },
        { status: 502 }
      );
    }
    const json = await res.json();
    return Response.json(json);
  } catch (e) {
    return Response.json(
      { error: "Metadata fetch failed", details: String(e) },
      { status: 502 }
    );
  }
}
