import { NextRequest } from "next/server";
import { supabase } from "@/lib/supabase";

// GET /api/tokens/[mint] — Supabase index row (metadata + legacy columns). Not authoritative for bonding state; UI must use on-chain TokenState.
export async function GET(
  _req: NextRequest,
  ctx: RouteContext<"/api/tokens/[mint]">
) {
  try {
    const { mint } = await ctx.params;

    const { data, error } = await supabase
      .from("tokens")
      .select("*")
      .eq("mint", mint)
      .single();

    if (error) {
      if (error.code === "PGRST116") {
        return Response.json({ error: "Token not found" }, { status: 404 });
      }
      return Response.json({ error: error.message }, { status: 500 });
    }

    return Response.json(data);
  } catch (error) {
    return Response.json(
      { error: "Failed to fetch token", details: String(error) },
      { status: 500 }
    );
  }
}
