import { supabaseAdmin } from "@/lib/supabase-server";
import devRecentSeed from "../../../../../public/dev-recent-activity.json";

export const dynamic = "force-dynamic";

const DEV_RECENT = devRecentSeed as Record<
  string,
  { timestamp: string; signature?: string; side?: string }
>;

/**
 * GET /api/trades/recent-activity
 * Latest trade timestamp per mint (for Home → Moving tab).
 */
export async function GET() {
  try {
    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const { data, error } = await supabaseAdmin
      .from("trades")
      .select("mint, timestamp, signature, side")
      .gte("timestamp", since)
      .order("timestamp", { ascending: false })
      .limit(500);

    if (error) {
      console.warn("[recent-activity] Supabase:", error.message);
      return Response.json({
        since,
        byMint: { ...DEV_RECENT },
        unavailable: true,
        hint: "Run frontend/supabase/bootstrap.sql in Supabase SQL editor",
      });
    }

    const byMint: Record<
      string,
      { timestamp: string; signature: string; side: string }
    > = {};

    for (const row of data ?? []) {
      const m = typeof row.mint === "string" ? row.mint : "";
      if (!m || byMint[m]) continue;
      byMint[m] = {
        timestamp: String(row.timestamp),
        signature: String(row.signature ?? ""),
        side: String(row.side ?? "buy"),
      };
    }

    const merged = { ...DEV_RECENT, ...byMint };
    return Response.json({ since, byMint: merged, unavailable: false });
  } catch (e) {
    return Response.json({
      since: null,
      byMint: {},
      unavailable: true,
      error: String(e),
    });
  }
}
