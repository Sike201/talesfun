/**
 * Sum native SOL across EXC/phantom, id, and all .e2e-tmp trader keypairs.
 *   npx tsx --env-file=.env.local scripts/devnet-inventory-sol.ts
 */
import fs from "node:fs";
import path from "node:path";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";

const ROOT = path.resolve(__dirname, "..");
const TMP = path.join(ROOT, ".e2e-tmp");
const META = path.join(TMP, "talesfun-test-mint.json");

function loadKp(file: string): Keypair {
  return Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(file, "utf8")))
  );
}

function loadTraders(): Keypair[] {
  const seen = new Set<string>();
  const out: Keypair[] = [];
  for (const f of fs.readdirSync(TMP)) {
    if (!f.endsWith(".json")) continue;
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(TMP, f), "utf8"));
      const rows = Array.isArray(raw)
        ? raw
        : raw?.secret
          ? [raw]
          : raw?.traders || raw?.wallets || [];
      for (const r of rows) {
        const secret = r?.secret || r?.secretKey;
        if (!secret) continue;
        const kp = Keypair.fromSecretKey(Uint8Array.from(secret));
        const id = kp.publicKey.toBase58();
        if (seen.has(id)) continue;
        seen.add(id);
        out.push(kp);
      }
    } catch {
      /* skip */
    }
  }
  return out;
}

async function main() {
  const connection = new Connection(
    process.env.NEXT_PUBLIC_SOLANA_RPC_URL || "https://api.devnet.solana.com",
    "confirmed"
  );
  const meta = JSON.parse(fs.readFileSync(META, "utf8")) as { mint: string };
  const mint = new PublicKey(meta.mint);

  const community = loadKp(
    path.join(process.env.HOME!, ".config/solana/phantom.json")
  );
  const id = loadKp(path.join(process.env.HOME!, ".config/solana/id.json"));

  const rows: { label: string; pk: string; sol: number; tok: number }[] = [];

  async function row(label: string, kp: Keypair) {
    const sol = (await connection.getBalance(kp.publicKey)) / LAMPORTS_PER_SOL;
    let tok = 0;
    try {
      const ata = getAssociatedTokenAddressSync(mint, kp.publicKey, true);
      const b = await connection.getTokenAccountBalance(ata, "confirmed");
      tok = Number(b.value.uiAmountString || "0");
    } catch {
      /* none */
    }
    rows.push({
      label,
      pk: kp.publicKey.toBase58(),
      sol: Number(sol.toFixed(6)),
      tok: Number(tok.toFixed(2)),
    });
  }

  await row("EXC/phantom", community);
  await row("id", id);
  for (const kp of loadTraders()) {
    if (kp.publicKey.equals(community.publicKey) || kp.publicKey.equals(id.publicKey))
      continue;
    await row("trader", kp);
  }

  const totalSol = rows.reduce((s, r) => s + r.sol, 0);
  const totalTok = rows.reduce((s, r) => s + r.tok, 0);
  const withSol = rows.filter((r) => r.sol > 0.001);
  const withTok = rows.filter((r) => r.tok >= 1);

  console.log(
    JSON.stringify(
      {
        mint: meta.mint,
        communitySol: rows.find((r) => r.label === "EXC/phantom")?.sol,
        idSol: rows.find((r) => r.label === "id")?.sol,
        traderSol: Number(
          (totalSol - (rows[0]?.sol ?? 0) - (rows[1]?.sol ?? 0)).toFixed(6)
        ),
        walletsWithSol: withSol.length,
        leftoverTokenHolders: withTok.length,
        leftoverTokens: Number(totalTok.toFixed(2)),
        TOTAL_SOL: Number(totalSol.toFixed(6)),
      },
      null,
      2
    )
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
