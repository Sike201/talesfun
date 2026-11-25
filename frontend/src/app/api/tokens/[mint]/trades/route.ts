import { NextRequest } from "next/server";
import { supabase } from "@/lib/supabase";
import { listLocalTrades } from "@/lib/localTradeStore";
import {
  getIndexerRpcConnection,
  indexOmnipairSwapsForMint,
} from "@/lib/omnipairIndexer";

export const dynamic = "force-dynamic";
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

function jsonPage(page: Row[], meta?: Record<string, unknown>) {
  return Response.json(page, {
    headers: {
      "Cache-Control": "public, s-maxage=5, stale-while-revalidate=30",
      ...(meta?.source
        ? { "x-tales-trades-source": String(meta.source) }
        : {}),
    },
  });
}

// GET /api/tokens/[mint]/trades
// Fast path: warm Supabase. Slow path: batched on-chain index when DB is cold.
export async function GET(
  request: NextRequest,
  ctx: RouteContext<"/api/tokens/[mint]/trades">
) {
  const started = Date.now();
  try {
    const { mint } = await ctx.params;
    const { searchParams } = request.nextUrl;
    const limit = parseInt(searchParams.get("limit") || "50", 10);
    const offset = parseInt(searchParams.get("offset") || "0", 10);
    const skipChain = searchParams.get("skipChain") === "1";
    const forceSync = searchParams.get("sync") === "1";
    const gammPool = searchParams.get("gammPool")?.trim() || undefined;

    const bySig = collectKnownRows(mint);
    await Promise.race([
      mergeSupabaseTrades(mint, bySig),
      new Promise<void>((r) => setTimeout(r, 4000)),
    ]);

    const warmEnough = bySig.size >= Math.min(10, limit);
    const shouldSyncChain =
      !skipChain && (forceSync || bySig.size === 0 || !warmEnough);

    let source: "supabase" | "chain" | "merged" =
      bySig.size > 0 ? "supabase" : "supabase";

    if (shouldSyncChain) {
      try {
        const connection = getIndexerRpcConnection();
        const indexed = await indexOmnipairSwapsForMint(connection, mint, {
          limitPerPair: Math.min(80, Math.max(limit, 40)),
          gammPool,
          // When DB is warm, only fill gaps; when cold, rebuild from chain.
          knownSignatures: warmEnough ? new Set(bySig.keys()) : new Set(),
          deadlineMs: Date.now() + (warmEnough ? 6_000 : 18_000),
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
        source = warmEnough ? "merged" : "chain";
        console.info("[trade-history] on-chain sync", {
          mint,
          gammPool: indexed.gammPool,
          signaturesFetched: indexed.signaturesFetched,
          swapsIndexed: indexed.swapsIndexed,
          inMemory: indexed.trades.length,
          ms: Date.now() - started,
        });
      } catch (e) {
        console.warn("[trade-history] on-chain sync failed", mint, e);
      }
    } else {
      source = "supabase";
      console.info("[trade-history] warm supabase fast-path", {
        mint,
        rows: bySig.size,
        ms: Date.now() - started,
      });
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
      rows.length,
      "source:",
      source,
      "ms:",
      Date.now() - started
    );
    return jsonPage(page, { source });
  } catch (error) {
    return Response.json(
      { error: "Failed to fetch trades", details: String(error) },
      { status: 500 }
    );
  }
}
