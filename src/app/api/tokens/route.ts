import { NextRequest } from "next/server";
import { supabase } from "@/lib/supabase";
import { supabaseAdmin } from "@/lib/supabase-server";

// GET /api/tokens — list all tokens, filterable by ?phase=bonding|graduated
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = request.nextUrl;
    const phase = searchParams.get("phase");
    const limit = parseInt(searchParams.get("limit") || "50", 10);
    const offset = parseInt(searchParams.get("offset") || "0", 10);
    const creator = searchParams.get("creator");

    let query = supabase
      .from("tokens")
      .select("*")
      .order("created_at", { ascending: false })
      .range(offset, offset + limit - 1);

    if (phase) {
      query = query.eq("phase", phase);
    }

    if (creator) {
      query = query.eq("creator", creator);
    }

    const { data, error } = await query;

    if (error) {
      return Response.json({ error: error.message }, { status: 500 });
    }

    return Response.json(data);
  } catch (error) {
    return Response.json(
      { error: "Failed to fetch tokens", details: String(error) },
      { status: 500 }
    );
  }
}

// POST /api/tokens — upsert a token record (called by the indexer)
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();

    const { data, error } = await supabaseAdmin
      .from("tokens")
      .upsert(body, { onConflict: "mint" })
      .select()
      .single();

    if (error) {
      return Response.json({ error: error.message }, { status: 500 });
    }

    return Response.json(data, { status: 201 });
  } catch (error) {
    return Response.json(
      { error: "Failed to upsert token", details: String(error) },
      { status: 500 }
    );
  }
}
