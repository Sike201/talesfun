import type { Token } from "@/types";

/**
 * When `NEXT_PUBLIC_DEBUG_CHAIN_VS_SUPABASE=1`, logs on-chain token fields vs Supabase `tokens` row
 * so you can spot stale DB state (indexer/sync lag).
 */
export function logTokenStateChainVsSupabase(
  mintShort: string,
  chain: Pick<
    Token,
    | "phase"
    | "solRaised"
    | "tokensSold"
    | "chainRealSolReserveSol"
    | "chainRealTokenReserveRaw"
  >,
  supabaseRow: Record<string, unknown> | null
): void {
  if (process.env.NEXT_PUBLIC_DEBUG_CHAIN_VS_SUPABASE !== "1") return;

  console.log("[higher:chain-vs-sb] on-chain TokenState (source of truth)", {
    mint: mintShort,
    phase: chain.phase,
    sol_raised_sol: chain.solRaised,
    real_sol_reserve_sol: chain.chainRealSolReserveSol,
    real_token_reserve_raw: chain.chainRealTokenReserveRaw,
    tokens_sold_ui: chain.tokensSold,
  });

  console.log("[higher:chain-vs-sb] supabase tokens row (index/metadata only)", {
    mint: mintShort,
    phase: typeof supabaseRow?.phase === "string" ? supabaseRow.phase : supabaseRow?.phase,
    sol_raised: supabaseRow?.sol_raised,
    tokens_sold: supabaseRow?.tokens_sold,
    real_sol_reserve: supabaseRow?.real_sol_reserve,
    real_token_reserve: supabaseRow?.real_token_reserve,
  });
}
