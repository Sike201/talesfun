import { NextRequest } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-server";

// POST /api/trades — insert a trade record (called by the indexer)
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();

    const { data, error } = await supabaseAdmin
      .from("trades")
      .insert(body)
      .select()
      .single();

    if (error) {
      return Response.json({ error: error.message }, { status: 500 });
    }

    return Response.json(data, { status: 201 });
  } catch (error) {
    return Response.json(
      { error: "Failed to insert trade", details: String(error) },
      { status: 500 }
    );
  }
}
