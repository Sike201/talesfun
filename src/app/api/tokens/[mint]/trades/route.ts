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
      .select("*")
      .eq("mint", mint)
      .order("timestamp", { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) {
      return Response.json({ error: error.message }, { status: 500 });
    }

    return Response.json(data);
  } catch (error) {
    return Response.json(
      { error: "Failed to fetch trades", details: String(error) },
      { status: 500 }
    );
  }
}
