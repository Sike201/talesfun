import { NextRequest } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-server";

/**
 * GET /api/trades/volume-24h
 * Optional: ?mint=<pubkey> — restrict rows and response to that mint.
 * Returns summed `sol_amount_raw` (lamports string per mint) for trades in the last 24h.
 */
export async function GET(request: NextRequest) {
  const mintFilter = request.nextUrl.searchParams.get("mint")?.trim() || null;
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  console.log("[volume24h] mint queried:", mintFilter ?? "ALL");
  console.log("[volume24h] since (UTC):", since);

  try {
    let q = supabaseAdmin
      .from("trades")
      .select("mint, sol_amount_raw")
      .gte("timestamp", since);

    if (mintFilter) {
      q = q.eq("mint", mintFilter);
    }

    const { data, error } = await q;

    if (error) {
      console.error("[volume24h] Supabase error:", error.message);
      return Response.json({ error: error.message }, { status: 500 });
    }

    const rows = data ?? [];
    const sums = new Map<string, bigint>();
    for (const row of rows) {
      const m = typeof row.mint === "string" ? row.mint : "";
      const raw =
        typeof row.sol_amount_raw === "string" ? row.sol_amount_raw.trim() : "0";
      if (!m) continue;
      let add = BigInt(0);
      try {
        add = BigInt(raw || "0");
      } catch {
        continue;
      }
      sums.set(m, (sums.get(m) ?? BigInt(0)) + add);
    }

    const byMint: Record<string, string> = {};
    for (const [m, lamports] of sums) {
      byMint[m] = lamports.toString();
    }

    console.log("[volume24h] raw 24h trade row count:", rows.length);
    console.log("[volume24h] mints with non-zero 24h volume:", Object.keys(byMint).length);
    if (mintFilter) {
      const raw = byMint[mintFilter] ?? "0";
      console.log("[volume24h] raw 24h lamports sum for mint:", mintFilter, raw);
    }

    return Response.json({ since, byMint });
  } catch (e) {
    console.error("[volume24h] handler error:", e);
    return Response.json(
      { error: "Failed to load 24h volume", details: String(e) },
      { status: 500 }
    );
  }
}
