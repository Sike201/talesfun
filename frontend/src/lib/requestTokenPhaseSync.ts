/** Fire-and-forget: align Supabase `tokens.phase` with on-chain state (server verifies RPC). */
export function requestTokenPhaseSync(mint: string): void {
  void fetch(`/api/tokens/${encodeURIComponent(mint)}/sync-phase`, {
    method: "POST",
  }).catch((err) => {
    console.warn("[sync-phase] request failed", mint.slice(0, 8), err);
  });
}
