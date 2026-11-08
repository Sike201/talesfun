import { supabaseAdmin } from "@/lib/supabase-server";

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
  const { data, error } = await supabaseAdmin
    .from("trades")
    .upsert(row, { onConflict: "signature", ignoreDuplicates: false })
    .select("id")
    .single();

  if (error) {
    return { ok: false, error: error.message };
  }
  return { ok: true, id: data?.id as string | undefined };
}
