import { NextRequest } from "next/server";
import { supabase } from "@/lib/supabase";
import { listLocalTrades } from "@/lib/localTradeStore";

// GET /api/tokens/[mint]/trades — trade history for a token (Supabase + local on-chain journal)
export async function GET(
  request: NextRequest,
  ctx: RouteContext<"/api/tokens/[mint]/trades">
) {
  try {
    const { mint } = await ctx.params;
    const { searchParams } = request.nextUrl;
    const limit = parseInt(searchParams.get("limit") || "50", 10);
    const offset = parseInt(searchParams.get("offset") || "0", 10);

    type Row = {
      id?: string;
      mint: string;
      signature: string;
      side: string;
      wallet: string;
      sol_amount_raw: string;
      token_amount_raw: string;
      price_sol: number;
      timestamp: string;
      source: string;
    };

    const bySig = new Map<string, Row>();

    try {
      const { data, error } = await supabase
        .from("trades")
        .select(
          "id, mint, signature, side, wallet, sol_amount_raw, token_amount_raw, price_sol, timestamp, source"
        )
        .eq("mint", mint)
        .order("timestamp", { ascending: false })
        .range(0, 499);
      if (error) {
        console.warn("[trade-history] Supabase error", mint, error.message);
      } else {
        for (const r of data ?? []) {
          if (r?.signature) bySig.set(r.signature, r as Row);
        }
      }
    } catch (e) {
      console.warn("[trade-history] Supabase unreachable", e);
    }

    for (const t of listLocalTrades(mint)) {
      if (!bySig.has(t.signature)) {
        bySig.set(t.signature, {
          mint: t.mint,
          signature: t.signature,
          side: t.side,
          wallet: t.wallet,
          sol_amount_raw: t.sol_amount_raw,
          token_amount_raw: t.token_amount_raw,
          price_sol: t.price_sol,
          timestamp: t.timestamp,
          source: t.source,
        });
      }
    }

    const rows = [...bySig.values()].sort(
      (a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp)
    );
    const page = rows.slice(offset, offset + limit);
    console.log(
      "[trade-history] GET trades mint:",
      mint,
      "row count:",
      page.length,
      "total:",
      rows.length
    );
    return Response.json(page);
  } catch (error) {
    return Response.json(
      { error: "Failed to fetch trades", details: String(error) },
      { status: 500 }
    );
  }
}
