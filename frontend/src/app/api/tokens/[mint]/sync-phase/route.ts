import { NextRequest } from "next/server";
import { Connection, PublicKey } from "@solana/web3.js";
import {
  chainPhaseLabelFromTokenState,
  getReadOnlyProgram,
  getTokenStatePDA,
} from "@/lib/program";
import { supabaseAdmin } from "@/lib/supabase-server";

/**
 * POST /api/tokens/[mint]/sync-phase
 * Reads on-chain `token_state` (source of truth), updates Supabase `tokens.phase` if it differs.
 * Does not sync reserves or `sol_raised` — those are indexer/backend concerns; the UI must read RPC.
 * No wallet signature — safe to call after trades or page load.
 */
export async function POST(
  _req: NextRequest,
  ctx: { params: Promise<{ mint: string }> }
) {
  const { mint: rawMint } = await ctx.params;
  const mint = rawMint?.trim();
  if (!mint) {
    return Response.json({ error: "Missing mint" }, { status: 400 });
  }

  const rpc =
    process.env.NEXT_PUBLIC_SOLANA_RPC_URL || "https://api.devnet.solana.com";

  try {
    const mintPk = new PublicKey(mint);
    const connection = new Connection(rpc, "confirmed");
    const program = getReadOnlyProgram(connection);
    const [pda] = getTokenStatePDA(mintPk);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const state = await (program.account as any).tokenState.fetch(pda);
    const chainPhase = chainPhaseLabelFromTokenState(state);

    const { data: row, error: selErr } = await supabaseAdmin
      .from("tokens")
      .select("mint, phase")
      .eq("mint", mint)
      .maybeSingle();

    if (selErr) {
      return Response.json({ error: selErr.message }, { status: 500 });
    }

    if (!row) {
      return Response.json({
        ok: true,
        skipped: true,
        reason: "no_supabase_row",
        chainPhase,
      });
    }

    if (row.phase === chainPhase) {
      return Response.json({
        ok: true,
        synced: false,
        phase: chainPhase,
      });
    }

    const { error: upErr } = await supabaseAdmin
      .from("tokens")
      .update({ phase: chainPhase })
      .eq("mint", mint);

    if (upErr) {
      return Response.json({ error: upErr.message }, { status: 500 });
    }

    return Response.json({
      ok: true,
      synced: true,
      phase: chainPhase,
      previousPhase: row.phase,
    });
  } catch (e) {
    console.error("[sync-phase]", mint, e);
    return Response.json(
      { error: "sync_failed", details: String(e) },
      { status: 500 }
    );
  }
}
