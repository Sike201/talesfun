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

const TOKEN_PHASES = new Set(["bonding", "ready_to_graduate", "graduated"]);

function trimStr(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function optStr(v: unknown): string | null {
  const s = trimStr(v);
  return s === "" ? null : s;
}

/** Build row for `public.tokens` (see supabase-schema.sql). */
function normalizeTokenUpsert(body: Record<string, unknown>) {
  const mint = trimStr(body.mint);
  const creator = trimStr(body.creator);
  const name = trimStr(body.name);
  const symbol = trimStr(body.symbol);
  if (!mint || !creator || !name || !symbol) {
    return { error: "Missing required fields: mint, creator, name, symbol" as const };
  }

  const phaseRaw = trimStr(body.phase) || "bonding";
  const phase = TOKEN_PHASES.has(phaseRaw) ? phaseRaw : "bonding";

  const row: Record<string, unknown> = {
    mint,
    creator,
    name,
    symbol,
    creator_fee_recipient: optStr(body.creator_fee_recipient),
    uri: optStr(body.uri),
    image_url: optStr(body.image_url),
    description: optStr(body.description),
    about: optStr(body.about ?? body.description),
    twitter: optStr(body.twitter),
    telegram: optStr(body.telegram),
    website: optStr(body.website),
    phase,
  };

  if (body.total_supply != null && body.total_supply !== "") {
    row.total_supply = body.total_supply;
  }

  return { row };
}

// POST /api/tokens — upsert a token (launch sync / indexer)
export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as Record<string, unknown>;
    const normalized = normalizeTokenUpsert(body);
    if ("error" in normalized) {
      console.warn("[higher.run] /api/tokens POST: validation failed:", normalized.error);
      return Response.json({ error: normalized.error }, { status: 400 });
    }

    const { row } = normalized;
    console.log("[higher.run] /api/tokens POST: persist payload:", JSON.stringify(row));

    const { data, error } = await supabaseAdmin
      .from("tokens")
      .upsert(row, { onConflict: "mint" })
      .select()
      .single();

    if (error) {
      console.error(
        "[higher.run] /api/tokens POST: Supabase error:",
        error.message,
        "code:",
        error.code,
        "details:",
        error.details
      );
      return Response.json(
        { error: error.message, code: error.code, details: error.details },
        { status: 500 }
      );
    }

    console.log("[higher.run] /api/tokens POST: Supabase upsert ok, mint:", data?.mint);
    return Response.json(data, { status: 201 });
  } catch (error) {
    console.error("[higher.run] /api/tokens POST: handler error:", error);
    return Response.json(
      { error: "Failed to upsert token", details: String(error) },
      { status: 500 }
    );
  }
}
