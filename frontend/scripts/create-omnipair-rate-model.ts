/**
 * Omnipair: `create_rate_model` (optional for Higher bootstrap)
 *
 * The launchpad bootstrap flow passes a **fresh** `rate_model` signer into Omnipair `initialize`,
 * which typically **initializes that account inside the same instruction**. Use this script only if
 * you need a reusable on-chain rate model created ahead of time (or your binary requires it).
 *
 * `authority_signer` MUST be the same pubkey as `authority` stored in `futarchy_authority`
 * (the `GOVERNANCE_AUTHORITY_PUBKEY` you passed to `init_futarchy_authority`, if you used one).
 *
 * `rate_model` is a new signer keypair; fund its rent via the transaction (payer = authority_signer).
 *
 * Usage (from repo `frontend/`):
 *   RPC_URL=https://api.devnet.solana.com \
 *   OMNIPAIR_PROGRAM_ID=<your deployed omnipair program id> \
 *   AUTHORITY_SIGNER_KEYPAIR=$HOME/.config/solana/id.json \
 *   npx --yes tsx scripts/create-omnipair-rate-model.ts
 *
 * Optional: RATE_MODEL_OUT=/path/rate-model.json — writes the new rate_model pubkey for your records.
 */
import fs from "fs";
import path from "path";
import { Program, AnchorProvider, BN, Wallet, type Idl } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";

const OFFICIAL_OMNIPAIR_PROGRAM =
  "omnixgS8fnqHfCcTGKWj6JtKjzpJZ1Y5y9pyFkQDkYE";

function omnipairProgramIdFromEnv(): PublicKey {
  const s =
    process.env.OMNIPAIR_PROGRAM_ID ||
    process.env.NEXT_PUBLIC_OMNIPAIR_PROGRAM_ID ||
    OFFICIAL_OMNIPAIR_PROGRAM;
  return new PublicKey(s);
}

function futarchyAuthorityPda(programId: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("futarchy_authority")],
    programId
  );
  return pda;
}

function loadOmnipairIdlFromDisk(): Idl {
  const idlPath = path.join(
    process.cwd(),
    "node_modules/@omnipair/program-interface/dist/idl.json"
  );
  return JSON.parse(fs.readFileSync(idlPath, "utf8")) as Idl;
}

function loadKeypair(jsonPath: string): Keypair {
  const abs = path.resolve(jsonPath);
  const secret = JSON.parse(fs.readFileSync(abs, "utf8")) as number[];
  return Keypair.fromSecretKey(Uint8Array.from(secret));
}

async function main() {
  const rpc =
    process.env.RPC_URL ||
    process.env.SOLANA_RPC_URL ||
    "https://api.devnet.solana.com";

  const kpPath =
    process.env.AUTHORITY_SIGNER_KEYPAIR ||
    process.env.UPGRADE_AUTHORITY_KEYPAIR ||
    path.join(process.env.HOME || "", ".config/solana/id.json");

  const authoritySigner = loadKeypair(kpPath);
  const connection = new Connection(rpc, "confirmed");
  const OMNIPAIR_PROGRAM_ID = omnipairProgramIdFromEnv();

  const futarchyPda = futarchyAuthorityPda(OMNIPAIR_PROGRAM_ID);
  const futarchyAccount = await connection.getAccountInfo(futarchyPda, "confirmed");
  if (!futarchyAccount) {
    console.error(
      `Missing futarchy_authority at ${futarchyPda.toBase58()}. Run init-omnipair-futarchy-authority first.`
    );
    process.exit(1);
  }

  const wallet = new Wallet(authoritySigner);
  const provider = new AnchorProvider(connection, wallet, {
    commitment: "confirmed",
  });
  const rawIdl = loadOmnipairIdlFromDisk();
  const idl = { ...rawIdl, address: OMNIPAIR_PROGRAM_ID.toBase58() };
  const program = new Program(idl as Idl, provider);

  const rateModelKp = Keypair.generate();

  // Safe dev defaults (u64); tune if your on-chain validator rejects ranges.
  const args = {
    targetUtilStartBps: new BN(process.env.TARGET_UTIL_START_BPS ?? "7000"),
    targetUtilEndBps: new BN(process.env.TARGET_UTIL_END_BPS ?? "9000"),
    halfLifeMs: new BN(process.env.RATE_HALF_LIFE_MS ?? "86400000"),
    minRateBps: new BN(process.env.MIN_RATE_BPS ?? "100"),
    maxRateBps: new BN(process.env.MAX_RATE_BPS ?? "5000"),
    initialRateBps: new BN(process.env.INITIAL_RATE_BPS ?? "500"),
  };

  console.log("RPC:", rpc);
  console.log("Omnipair program:", OMNIPAIR_PROGRAM_ID.toBase58());
  console.log("authority_signer:", authoritySigner.publicKey.toBase58());
  console.log("new rate_model:", rateModelKp.publicKey.toBase58());

  const sig = await program.methods
    .createRateModel(args)
    .accounts({
      authoritySigner: authoritySigner.publicKey,
      rateModel: rateModelKp.publicKey,
    })
    .signers([rateModelKp])
    .rpc();

  console.log("create_rate_model tx:", sig);

  const out = process.env.RATE_MODEL_OUT;
  if (out) {
    fs.writeFileSync(
      path.resolve(out),
      JSON.stringify(
        {
          rateModel: rateModelKp.publicKey.toBase58(),
          secretKey: [...rateModelKp.secretKey],
          tx: sig,
        },
        null,
        2
      ),
      "utf8"
    );
    console.log("Wrote", out);
  } else {
    console.log(
      "Save this rate_model pubkey if you need a fixed one for testing:",
      rateModelKp.publicKey.toBase58()
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
