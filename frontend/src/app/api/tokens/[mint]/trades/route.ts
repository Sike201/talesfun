import { NextRequest } from "next/server";
import { supabase } from "@/lib/supabase";

// GET /api/tokens/[mint]/trades — trade history for a token
export async function GET(
  request: NextRequest,
  ctx: RouteContext<"/api/tokens/[mint]/trades">
) {
  try {
    const { mint } = await ctx.params;
    const { searchParams } = request.nextUrl;
    const limit = parseInt(searchParams.get("limit") || "50", 10);
    const offset = parseInt(searchParams.get("offset") || "0", 10);

    const { data, error } = await supabase
      .from("trades")
      .select(
        "id, mint, signature, side, wallet, sol_amount_raw, token_amount_raw, price_sol, timestamp, source"
      )
      .eq("mint", mint)
      .order("timestamp", { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) {
      console.warn("[trade-history] GET trades Supabase error", mint, error.message);
      return Response.json({ error: error.message }, { status: 500 });
    }

    const rows = data ?? [];
    console.log(
      "[trade-history] GET trades mint:",
      mint,
      "row count:",
      rows.length,
      "limit",
      limit,
      "offset",
      offset
    );
    return Response.json(rows);
  } catch (error) {
    return Response.json(
      { error: "Failed to fetch trades", details: String(error) },
      { status: 500 }
    );
  }
}
