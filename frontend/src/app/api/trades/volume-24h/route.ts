import { NextRequest } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-server";
import { listLocalTrades } from "@/lib/localTradeStore";
import { getIndexerRpcConnection } from "@/lib/omnipairIndexer";
import { indexBondingTradesForMint } from "@/lib/bondingIndexer";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * GET /api/trades/volume-24h
 * Optional: ?mint=<pubkey> — restrict rows and response to that mint.
 * Returns summed `sol_amount_raw` (lamports string per mint) for trades in the last 24h.
 * Merges Supabase + local on-chain journal (`.data/onchain-trades.json`).
 * For a single mint, briefly indexes bonding-curve buys/sells so curve volume counts.
 */
export async function GET(request: NextRequest) {
  const mintFilter = request.nextUrl.searchParams.get("mint")?.trim() || null;
  const sinceMs = Date.now() - 24 * 60 * 60 * 1000;
  const since = new Date(sinceMs).toISOString();

  console.log("[volume24h] mint queried:", mintFilter ?? "ALL");
  console.log("[volume24h] since (UTC):", since);

  const sums = new Map<string, bigint>();
  const seenSig = new Set<string>();

  const addRow = (m: string, raw: string, signature?: string | null) => {
    if (!m) return;
    const sig = typeof signature === "string" ? signature.trim() : "";
    if (sig) {
      if (seenSig.has(sig)) return;
      seenSig.add(sig);
    }
    let add = BigInt(0);
    try {
      add = BigInt((raw || "0").trim());
    } catch {
      return;
    }
    sums.set(m, (sums.get(m) ?? BigInt(0)) + add);
  };

  // Backfill bonding-curve fills into trades so 24h volume includes pre-graduation.
  if (mintFilter) {
    try {
      const connection = getIndexerRpcConnection();
      const bonding = await indexBondingTradesForMint(connection, mintFilter, {
        limit: 100,
        deadlineMs: Date.now() + 10_000,
        persist: true,
      });
      console.info("[volume24h] bonding backfill", {
        mint: mintFilter,
        signaturesFetched: bonding.signaturesFetched,
        tradesIndexed: bonding.tradesIndexed,
      });
    } catch (e) {
      console.warn("[volume24h] bonding backfill failed", e);
    }
  }

  try {
    let q = supabaseAdmin
      .from("trades")
      .select("mint, sol_amount_raw, timestamp, side, signature")
      .gte("timestamp", since)
      .in("side", ["buy", "sell"]);
    if (mintFilter) q = q.eq("mint", mintFilter);
    const { data, error } = await q;
    if (error) {
      console.error("[volume24h] Supabase error:", error.message);
    } else {
      for (const row of data ?? []) {
        addRow(
          typeof row.mint === "string" ? row.mint : "",
          typeof row.sol_amount_raw === "string" ? row.sol_amount_raw : "0",
          typeof (row as { signature?: string }).signature === "string"
            ? (row as { signature?: string }).signature
            : null
        );
      }
    }
  } catch (e) {
    console.warn("[volume24h] Supabase unreachable", e);
  }

  for (const t of listLocalTrades(mintFilter ?? undefined)) {
    if (t.side !== "buy" && t.side !== "sell") continue;
    const ts = Date.parse(t.timestamp);
    if (!Number.isFinite(ts) || ts < sinceMs) continue;
    addRow(t.mint, t.sol_amount_raw, t.signature);
  }

  const byMint: Record<string, string> = {};
  for (const [m, lamports] of sums) {
    byMint[m] = lamports.toString();
  }

  console.log("[volume24h] mints with non-zero 24h volume:", Object.keys(byMint).length);
  return Response.json({ since, byMint, source: "supabase+local" });
}
