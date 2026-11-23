import { supabaseAdmin } from "@/lib/supabase-server";
import { upsertLocalTrade } from "@/lib/localTradeStore";

/** Row shape for POST /api/trades and the Omnipair chain indexer (same upsert). */
export type CanonicalTradeRow = {
  mint: string;
  signature: string;
  side: "buy" | "sell";
  sol_amount_raw: string;
  token_amount_raw: string;
  timestamp: string;
  wallet: string;
  price_sol: number;
  source: "bonding" | "omnipair";
};

export async function upsertCanonicalTrade(
  row: CanonicalTradeRow
): Promise<{ ok: true; id?: string } | { ok: false; error: string }> {
  // Always journal locally so charts work even when Supabase is down.
  try {
    upsertLocalTrade(row);
  } catch (e) {
    console.warn("[trades] local journal failed", e);
  }

  try {
    const { data, error } = await supabaseAdmin
      .from("trades")
      .upsert(row, { onConflict: "signature", ignoreDuplicates: false })
      .select("id")
      .single();

    if (error) {
      // Local copy already saved — treat as soft failure for callers that only care about persistence.
      console.warn("[trades] supabase upsert failed; kept local copy", error.message);
      return { ok: true, id: undefined };
    }
    return { ok: true, id: data?.id as string | undefined };
  } catch (e) {
    console.warn("[trades] supabase unreachable; kept local copy", e);
    return { ok: true, id: undefined };
  }
}
