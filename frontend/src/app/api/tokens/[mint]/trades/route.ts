import { NextRequest } from "next/server";
import { supabase } from "@/lib/supabase";
import { listLocalTrades } from "@/lib/localTradeStore";
import {
  getIndexerRpcConnection,
  indexOmnipairSwapsForMint,
} from "@/lib/omnipairIndexer";

export const dynamic = "force-dynamic";
/** Allow enough time for one batched RPC sync on Vercel. */
export const maxDuration = 30;

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

function collectKnownRows(mint: string): Map<string, Row> {
  const bySig = new Map<string, Row>();
  for (const t of listLocalTrades(mint)) {
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
  return bySig;
}

async function mergeSupabaseTrades(mint: string, bySig: Map<string, Row>) {
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
      return;
    }
    for (const r of data ?? []) {
      if (r?.signature && !bySig.has(r.signature)) {
        bySig.set(r.signature, r as Row);
      }
    }
  } catch (e) {
    console.warn("[trade-history] Supabase unreachable", e);
  }
}

// GET /api/tokens/[mint]/trades — on-chain Omnipair swaps (+ local/Supabase if available)
export async function GET(
  request: NextRequest,
  ctx: RouteContext<"/api/tokens/[mint]/trades">
) {
  try {
    const { mint } = await ctx.params;
    const { searchParams } = request.nextUrl;
    const limit = parseInt(searchParams.get("limit") || "50", 10);
    const offset = parseInt(searchParams.get("offset") || "0", 10);
    const skipChain = searchParams.get("skipChain") === "1";
    const gammPool = searchParams.get("gammPool")?.trim() || undefined;

    const bySig = collectKnownRows(mint);
    // Cap Supabase wait — dead host must not block the page.
    await Promise.race([
      mergeSupabaseTrades(mint, bySig),
      new Promise<void>((r) => setTimeout(r, 2500)),
    ]);

    // Live chain sync is the source of truth on Vercel (ephemeral FS + dead Supabase).
    if (!skipChain) {
      try {
        const connection = getIndexerRpcConnection();
        const indexed = await indexOmnipairSwapsForMint(connection, mint, {
          limitPerPair: Math.min(80, Math.max(limit, 40)),
          gammPool,
          // Rebuild activity from chain even when journal is empty.
          knownSignatures: new Set(),
          deadlineMs: Date.now() + 18_000,
          persist: true,
        });
        for (const t of indexed.trades) {
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
        console.info("[trade-history] on-chain sync", {
          mint,
          gammPool: indexed.gammPool,
          signaturesFetched: indexed.signaturesFetched,
          swapsIndexed: indexed.swapsIndexed,
          inMemory: indexed.trades.length,
          errors: indexed.errors.slice(0, 3),
        });
      } catch (e) {
        console.warn("[trade-history] on-chain sync failed", mint, e);
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
    return Response.json(page, {
      headers: {
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    return Response.json(
      { error: "Failed to fetch trades", details: String(error) },
      { status: 500 }
    );
  }
}
