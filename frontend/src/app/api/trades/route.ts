import { NextRequest } from "next/server";
import { priceSolFromRaw } from "@/lib/utils";
import { upsertCanonicalTrade } from "@/lib/persistCanonicalTrade";

type TradeBody = {
  mint?: string;
  signature?: string;
  side?: string;
  sol_amount_raw?: string;
  token_amount_raw?: string;
  timestamp?: string;
  wallet?: string;
  price_sol?: number;
  /** bonding | omnipair — column must exist: ALTER TABLE trades ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'bonding'; */
  source?: string;
};

// POST /api/trades — idempotent trade row (unique `signature`).
// Bonding: primary writer is still the client. Omnipair: canonical rows come from
// GET/POST /api/cron/omnipair-trades (chain indexer); client POST is optional dedupe.
export async function POST(request: NextRequest) {
  console.log("[higher.run] FRONTEND /api/trades POST handler invoked");
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
    let price_sol =
      typeof body.price_sol === "number" && Number.isFinite(body.price_sol)
        ? body.price_sol
        : Number(body.price_sol);
    if (!Number.isFinite(price_sol)) {
      price_sol = priceSolFromRaw(sol_amount_raw, token_amount_raw);
      console.log("[higher.run] /api/trades: derived price_sol from raw (finite fallback)");
    }

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
    const source =
      body.source === "omnipair"
        ? "omnipair"
        : body.source === "bonding"
          ? "bonding"
          : "bonding";

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
      source,
    } satisfies import("@/lib/persistCanonicalTrade").CanonicalTradeRow;
    console.log("[higher.run] /api/trades: normalized row keys:", Object.keys(row));
    console.log("[higher.run] /api/trades: normalized row (preview):", {
      ...row,
      signature: `${signature.slice(0, 8)}…`,
    });

    const up = await upsertCanonicalTrade(row);
    if (!up.ok) {
      console.error("[higher.run] /api/trades: Supabase upsert error:", up.error);
      return Response.json({ error: up.error }, { status: 500 });
    }

    console.log("[higher.run] /api/trades: Supabase upsert ok, id:", up.id ?? "(no id)");
    console.log(
      "[trade-history] write mint:",
      mint,
      "side:",
      side,
      "signature:",
      `${signature.slice(0, 8)}…`
    );
    return Response.json({ id: up.id, ...row }, { status: 201 });
  } catch (error) {
    console.error("[higher.run] /api/trades: handler error:", error);
    return Response.json(
      { error: "Failed to persist trade", details: String(error) },
      { status: 500 }
    );
  }
}
