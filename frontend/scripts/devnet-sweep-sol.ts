/**
 * Sweep leftover SOL (+ unwrap WSOL) from known e2e trader keypairs into phantom payer.
 */
import fs from "node:fs";
import path from "node:path";
import {
  Connection,
  Keypair,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
  LAMPORTS_PER_SOL,
  PublicKey,
} from "@solana/web3.js";
import {
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
  createCloseAccountInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";

const rpc =
  process.env.NEXT_PUBLIC_SOLANA_RPC_URL || "https://api.devnet.solana.com";
const conn = new Connection(rpc, "confirmed");
const dest = Keypair.fromSecretKey(
  Uint8Array.from(
    JSON.parse(
      fs.readFileSync(
        path.join(process.env.HOME!, ".config/solana/phantom.json"),
        "utf8"
      )
    )
  )
);
const mint = new PublicKey(
  process.env.MINT || "vgACbDyQWY6hK3rK2WDxfc2PbGNnTTKvKAjwgsS11Ez"
);

function extractKeypairs(raw: unknown): Keypair[] {
  const out: Keypair[] = [];
  const push = (s: unknown) => {
    if (!Array.isArray(s) || typeof s[0] !== "number") return;
    try {
      out.push(Keypair.fromSecretKey(Uint8Array.from(s as number[])));
    } catch {
      /* ignore */
    }
  };
  if (Array.isArray(raw) && typeof raw[0] === "number") {
    push(raw);
    return out;
  }
  if (Array.isArray(raw)) {
    for (const row of raw) {
      if (row && typeof row === "object") {
        const r = row as Record<string, unknown>;
        push(r.secret ?? r.secretKey);
      } else push(row);
    }
    return out;
  }
  if (raw && typeof raw === "object") {
    const o = raw as Record<string, unknown>;
    push(o.secret ?? o.secretKey);
    for (const key of ["traders", "wallets", "keys"]) {
      if (Array.isArray(o[key])) out.push(...extractKeypairs(o[key]));
    }
  }
  return out;
}

async function main() {
  const seen = new Set<string>();
  const kps: Keypair[] = [];
  const tmp = path.join(__dirname, "..", ".e2e-tmp");
  for (const f of fs.readdirSync(tmp).filter(x => x.endsWith(".json"))) {
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(path.join(tmp, f), "utf8"));
    } catch {
      continue;
    }
    for (const kp of extractKeypairs(raw)) {
      const pk = kp.publicKey.toBase58();
      if (seen.has(pk)) continue;
      seen.add(pk);
      kps.push(kp);
    }
  }
  for (const f of ["id.json", "phantom.json", "resolver.json"]) {
    const p = path.join(process.env.HOME!, ".config/solana", f);
    if (!fs.existsSync(p)) continue;
    try {
      const s = JSON.parse(fs.readFileSync(p, "utf8"));
      const kp = Keypair.fromSecretKey(Uint8Array.from(s));
      if (!seen.has(kp.publicKey.toBase58())) kps.push(kp);
    } catch {
      /* ignore */
    }
  }

  console.log("wallets", kps.length);
  let moved = 0;
  let tokHolders = 0;
  for (const kp of kps) {
    try {
      const wata = getAssociatedTokenAddressSync(
        NATIVE_MINT,
        kp.publicKey,
        false,
        TOKEN_PROGRAM_ID
      );
      if (await conn.getAccountInfo(wata)) {
        const tx = new Transaction().add(
          createCloseAccountInstruction(
            wata,
            kp.publicKey,
            kp.publicKey,
            [],
            TOKEN_PROGRAM_ID
          )
        );
        await sendAndConfirmTransaction(conn, tx, [kp], {
          commitment: "confirmed",
        });
        console.log("unwrap", kp.publicKey.toBase58().slice(0, 8));
      }
    } catch {
      /* ignore */
    }

    let tok = 0;
    try {
      const ata = getAssociatedTokenAddressSync(mint, kp.publicKey, true);
      tok = Number(
        (await conn.getTokenAccountBalance(ata)).value.uiAmountString || 0
      );
    } catch {
      /* ignore */
    }
    const sol = await conn.getBalance(kp.publicKey);
    if (tok > 100) {
      tokHolders++;
      console.log(
        "TOK",
        kp.publicKey.toBase58().slice(0, 8),
        tok.toFixed(0),
        "sol",
        (sol / LAMPORTS_PER_SOL).toFixed(4)
      );
    }
    if (sol > 15_000 && !kp.publicKey.equals(dest.publicKey)) {
      try {
        const lamports = sol - 5_000;
        const tx = new Transaction().add(
          SystemProgram.transfer({
            fromPubkey: kp.publicKey,
            toPubkey: dest.publicKey,
            lamports,
          })
        );
        await sendAndConfirmTransaction(conn, tx, [kp], {
          commitment: "confirmed",
        });
        moved += lamports;
        console.log(
          "swept",
          (lamports / LAMPORTS_PER_SOL).toFixed(4),
          kp.publicKey.toBase58().slice(0, 8)
        );
      } catch (e) {
        console.log(
          "skip",
          kp.publicKey.toBase58().slice(0, 8),
          e instanceof Error ? e.message.slice(0, 60) : e
        );
      }
    }
  }
  const final = await conn.getBalance(dest.publicKey);
  console.log(
    JSON.stringify(
      {
        tokHolders,
        moved: +(moved / LAMPORTS_PER_SOL).toFixed(4),
        payer: +(final / LAMPORTS_PER_SOL).toFixed(4),
      },
      null,
      2
    )
  );
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
