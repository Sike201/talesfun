/**
 * Upsert all on-chain token_state rows into Supabase `tokens` (Explore warm cache).
 *
 *   npx tsx --env-file=.env.local scripts/sync-tokens-from-chain.ts
 */
import { Connection } from "@solana/web3.js";
import { createClient } from "@supabase/supabase-js";
import {
  fetchAllTokenStatesAsTokens,
} from "../src/lib/program";

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const secret = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !secret) throw new Error("Supabase env missing");

  const admin = createClient(url, secret, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const connection = new Connection(
    process.env.NEXT_PUBLIC_SOLANA_RPC_URL || "https://api.devnet.solana.com",
    "confirmed"
  );

  const t0 = Date.now();
  const tokens = await fetchAllTokenStatesAsTokens(connection, null);
  console.log("chain tokens", tokens.length, "ms", Date.now() - t0);

  const rows = tokens.map((t) => ({
    mint: t.mint,
    creator: t.creator || t.creatorFeeRecipient || "unknown",
    creator_fee_recipient: t.creatorFeeRecipient || null,
    name: t.name,
    symbol: t.ticker,
    uri: (t as { uri?: string }).uri || null,
    image_url: t.imageUrl || null,
    description: t.description || null,
    about: t.description || null,
    phase: t.phase,
    gamm_pool: t.gammPool || null,
    current_price: t.currentPrice,
    market_cap: t.marketCap,
    sol_raised: Math.floor(t.solRaised * 1e9),
    created_at: t.createdAt.toISOString(),
  }));

  const chunk = 50;
  let ok = 0;
  for (let i = 0; i < rows.length; i += chunk) {
    const batch = rows.slice(i, i + chunk);
    const { error } = await admin.from("tokens").upsert(batch, {
      onConflict: "mint",
    });
    if (error) {
      console.error("upsert fail", error.message);
      process.exit(1);
    }
    ok += batch.length;
  }
  console.log("SYNC OK", { upserted: ok, ms: Date.now() - t0 });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
