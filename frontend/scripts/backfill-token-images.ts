/**
 * Backfill public.tokens.uri + image_url from on-chain Metaplex metadata JSON.
 * Makes Explore/Landing show art on first paint (no slow /api/metadata waterfall).
 *
 *   npx tsx --env-file=.env.local scripts/backfill-token-images.ts
 */
import { Connection, PublicKey } from "@solana/web3.js";
import { createClient } from "@supabase/supabase-js";
import { fetchAllTokenStatesAsTokens } from "../src/lib/program";
import {
  extractIpfsPath,
  pinataDedicatedGatewayHost,
} from "../src/lib/ipfs";

const METADATA_PROGRAM_ID = new PublicKey(
  "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s"
);

function metaplexPda(mint: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("metadata"),
      METADATA_PROGRAM_ID.toBuffer(),
      mint.toBuffer(),
    ],
    METADATA_PROGRAM_ID
  );
  return pda;
}

/** Best-effort URI extract from Metaplex Metadata account bytes. */
function uriFromMetadataAccount(data: Buffer): string | null {
  const s = data.toString("utf8");
  const m = s.match(/https?:\/\/[^\u0000\s]+|ipfs:\/\/[^\u0000\s]+/);
  if (!m?.[0]) return null;
  return m[0].replace(/\0+$/g, "").replace(/[^\x20-\x7E]+$/g, "").trim();
}

async function fetchMetadataJson(
  uri: string
): Promise<{ image?: string; description?: string } | null> {
  const jwt = process.env.PINATA_JWT?.trim();
  const path = extractIpfsPath(uri);
  const attempts: { url: string; headers?: HeadersInit }[] = [];
  if (path) {
    const dedicated = `https://${pinataDedicatedGatewayHost()}/ipfs/${path}`;
    if (jwt) {
      attempts.push({
        url: dedicated,
        headers: { Authorization: `Bearer ${jwt}` },
      });
    }
    attempts.push({ url: dedicated });
    attempts.push({ url: `https://gateway.pinata.cloud/ipfs/${path}` });
  } else {
    attempts.push({ url: uri });
  }
  for (const a of attempts) {
    try {
      const res = await fetch(a.url, {
        headers: { Accept: "application/json", ...(a.headers || {}) },
      });
      if (!res.ok) continue;
      const json = (await res.json()) as { image?: string; description?: string };
      if (json && typeof json === "object") return json;
    } catch {
      /* next */
    }
  }
  return null;
}

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

  const tokens = await fetchAllTokenStatesAsTokens(connection, null);
  console.log("tokens", tokens.length);

  let updated = 0;
  let skipped = 0;
  let failed = 0;

  for (const t of tokens) {
    try {
      let metaUri = t.metadataUri?.trim() || "";
      if (!metaUri) {
        const info = await connection.getAccountInfo(
          metaplexPda(new PublicKey(t.mint)),
          "confirmed"
        );
        if (info?.data) metaUri = uriFromMetadataAccount(Buffer.from(info.data)) || "";
      }
      if (!metaUri) {
        skipped += 1;
        console.log("skip no uri", t.ticker, t.mint.slice(0, 8));
        continue;
      }

      const json = await fetchMetadataJson(metaUri);
      const image = json?.image?.trim();
      if (!image) {
        skipped += 1;
        console.log("skip no image", t.ticker, metaUri.slice(0, 60));
        continue;
      }

      const { error } = await admin
        .from("tokens")
        .upsert(
          {
            mint: t.mint,
            creator: t.creator || t.creatorFeeRecipient || "unknown",
            creator_fee_recipient: t.creatorFeeRecipient || null,
            name: t.name,
            symbol: t.ticker,
            uri: metaUri,
            image_url: image,
            description: json?.description || t.description || null,
            about: json?.description || t.description || null,
            phase: t.phase,
            gamm_pool: t.gammPool || null,
            current_price: t.currentPrice,
            market_cap: t.marketCap,
            sol_raised: Math.floor(t.solRaised * 1e9),
            updated_at: new Date().toISOString(),
          },
          { onConflict: "mint" }
        );

      if (error) {
        failed += 1;
        console.error("upsert fail", t.ticker, error.message);
      } else {
        updated += 1;
        console.log("OK", t.ticker, image.slice(0, 70));
      }
    } catch (e) {
      failed += 1;
      console.error(
        "fail",
        t.ticker,
        e instanceof Error ? e.message : e
      );
    }
  }

  console.log("BACKFILL DONE", { updated, skipped, failed });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
