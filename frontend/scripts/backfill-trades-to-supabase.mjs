/**
 * Index on-chain Omnipair swaps for a mint (or all from local journal) into Supabase.
 *
 *   node --env-file=.env.local scripts/backfill-trades-to-supabase.mjs [mint]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { spawnSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

function loadLocalTrades(mint) {
  const p = path.join(ROOT, ".data", "onchain-trades.json");
  if (!fs.existsSync(p)) return [];
  const j = JSON.parse(fs.readFileSync(p, "utf8"));
  const trades = Array.isArray(j.trades) ? j.trades : [];
  return mint ? trades.filter((t) => t.mint === mint) : trades;
}

async function main() {
  const mintArg = process.argv[2]?.trim();
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const secret = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !secret) throw new Error("Supabase env missing");

  const admin = createClient(url, secret, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // Probe tables
  const probe = await admin.from("trades").select("signature", { head: true, count: "exact" });
  if (probe.error) {
    console.error("Supabase trades table missing/unavailable:", probe.error.message);
    console.error("Run bootstrap SQL or: SUPABASE_DB_PASSWORD=… node --env-file=.env.local scripts/apply-supabase-schema.mjs");
    process.exit(1);
  }

  if (mintArg) {
    console.log("indexing chain for", mintArg);
    const tsx = path.join(ROOT, "node_modules", ".bin", "tsx");
    const r = spawnSync(
      tsx,
      [
        "--env-file=.env.local",
        "-e",
        `
import { getIndexerRpcConnection, indexOmnipairSwapsForMint } from "./src/lib/omnipairIndexer.ts";
const mint = ${JSON.stringify(mintArg)};
const res = await indexOmnipairSwapsForMint(getIndexerRpcConnection(), mint, {
  limitPerPair: 80,
  knownSignatures: new Set(),
  deadlineMs: Date.now() + 25000,
  persist: true,
});
console.log(JSON.stringify({ swapsIndexed: res.swapsIndexed, trades: res.trades.length, gammPool: res.gammPool, errors: res.errors.slice(0,3) }));
`,
      ],
      { cwd: ROOT, encoding: "utf8", env: process.env }
    );
    process.stdout.write(r.stdout || "");
    process.stderr.write(r.stderr || "");
  }

  const local = loadLocalTrades(mintArg);
  console.log("upserting local journal rows", local.length);
  let ok = 0;
  let fail = 0;
  const chunk = 50;
  for (let i = 0; i < local.length; i += chunk) {
    const batch = local.slice(i, i + chunk).map((t) => ({
      mint: t.mint,
      signature: t.signature,
      side: t.side,
      sol_amount_raw: String(t.sol_amount_raw),
      token_amount_raw: String(t.token_amount_raw),
      timestamp: t.timestamp,
      wallet: t.wallet,
      price_sol: t.price_sol,
      source: t.source || "omnipair",
    }));
    const { error } = await admin.from("trades").upsert(batch, {
      onConflict: "signature",
    });
    if (error) {
      fail += batch.length;
      console.warn("batch fail", error.message);
    } else {
      ok += batch.length;
    }
  }

  const count = await admin
    .from("trades")
    .select("signature", { count: "exact", head: true })
    .maybeSingle();
  console.log("BACKFILL DONE", { ok, fail, supabaseCount: count.count });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
