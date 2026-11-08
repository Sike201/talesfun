import { NextRequest } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-server";

type TradeBody = {
  mint?: string;
  signature?: string;
  side?: string;
  sol_amount_raw?: string;
  token_amount_raw?: string;
  timestamp?: string;
  wallet?: string;
  price_sol?: number;
};

// POST /api/trades — idempotent bonding-curve trade row (unique signature)
export async function POST(request: NextRequest) {
  console.log("[higher.run] /api/trades: request received");
  try {
    const body = (await request.json()) as TradeBody;
    console.log("[higher.run] /api/trades: raw payload keys:", Object.keys(body));

    const mint = typeof body.mint === "string" ? body.mint.trim() : "";
    const signature = typeof body.signature === "string" ? body.signature.trim() : "";
    const side = body.side === "sell" ? "sell" : body.side === "buy" ? "buy" : "";
    const sol_amount_raw =
      typeof body.sol_amount_raw === "string" ? body.sol_amount_raw.trim() : "";
    const token_amount_raw =
      typeof body.token_amount_raw === "string" ? body.token_amount_raw.trim() : "";
    const wallet = typeof body.wallet === "string" ? body.wallet.trim() : "";
    const price_sol =
      typeof body.price_sol === "number" && Number.isFinite(body.price_sol)
        ? body.price_sol
        : Number(body.price_sol);

    if (
      !mint ||
      !signature ||
      !side ||
      !sol_amount_raw ||
      !token_amount_raw ||
      !wallet ||
      !Number.isFinite(price_sol)
    ) {
      console.warn("[higher.run] /api/trades: validation failed", {
        mint: !!mint,
        signature: !!signature,
        side: !!side,
        sol_amount_raw: !!sol_amount_raw,
        token_amount_raw: !!token_amount_raw,
        wallet: !!wallet,
        price_sol,
      });
      return Response.json({ error: "Invalid trade payload" }, { status: 400 });
    }

    const timestamp = body.timestamp || new Date().toISOString();

    console.log("[higher.run] /api/trades: incoming payload:", JSON.stringify(body));

    /** Canonical row only — do not write UI decimals into legacy bigint columns (sol_amount / token_amount). */
    const row = {
      mint,
      signature,
      side,
      sol_amount_raw,
      token_amount_raw,
      timestamp,
      wallet,
      price_sol,
    };
    console.log("[higher.run] /api/trades: normalized row keys:", Object.keys(row));
    console.log("[higher.run] /api/trades: normalized row (preview):", {
      ...row,
      signature: `${signature.slice(0, 8)}…`,
    });

    const { data, error } = await supabaseAdmin
      .from("trades")
      .upsert(row, { onConflict: "signature", ignoreDuplicates: false })
      .select()
      .single();

    if (error) {
      console.error(
        "[higher.run] /api/trades: Supabase error:",
        error.message,
        "code:",
        (error as { code?: string }).code,
        "details:",
        (error as { details?: string }).details,
        "hint:",
        (error as { hint?: string }).hint
      );
      return Response.json(
        {
          error: error.message,
          code: (error as { code?: string }).code,
          details: (error as { details?: string }).details,
        },
        { status: 500 }
      );
    }

    console.log("[higher.run] /api/trades: Supabase upsert ok, id:", data?.id ?? "(no id)");
    return Response.json(data, { status: 201 });
  } catch (error) {
    console.error("[higher.run] /api/trades: handler error:", error);
    return Response.json(
      { error: "Failed to persist trade", details: String(error) },
      { status: 500 }
    );
  }
}
