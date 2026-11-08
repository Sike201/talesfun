/**
 * Omnipair: `update_revenue_recipients` — replace `team_treasury` only (other recipients unchanged).
 *
 * Load IDL from disk (Node-safe; same pattern as init-omnipair-futarchy-authority.ts).
 * Set `OMNIPAIR_PROGRAM_ID` to your deploy (e.g. GP5yjX245UK28bLJQgG4WSHGT9ZyeoC6QpgwWAjekWv4 on devnet).
 *
 * `AUTHORITY_SIGNER_KEYPAIR` must match `futarchy_authority.authority` on-chain.
 *
 * Usage (from repo `frontend/`):
 *   RPC_URL=https://api.devnet.solana.com \
 *   OMNIPAIR_PROGRAM_ID=GP5yjX245UK28bLJQgG4WSHGT9ZyeoC6QpgwWAjekWv4 \
 *   AUTHORITY_SIGNER_KEYPAIR=$HOME/.config/solana/id.json \
 *   NEW_TEAM_TREASURY_PUBKEY=<new treasury base58> \
 *   npx --yes tsx scripts/update-omnipair-revenue-recipients.ts
 */
import fs from "fs";
import path from "path";
import { Program, AnchorProvider, Wallet, type Idl } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey, SystemProgram } from "@solana/web3.js";

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

function recipientsRow(recipients: {
  futarchyTreasury: PublicKey;
  buybacksVault: PublicKey;
  teamTreasury: PublicKey;
}) {
  return {
    futarchyTreasury: recipients.futarchyTreasury.toBase58(),
    buybacksVault: recipients.buybacksVault.toBase58(),
    teamTreasury: recipients.teamTreasury.toBase58(),
  };
}

async function main() {
  const rpc =
    process.env.RPC_URL ||
    process.env.SOLANA_RPC_URL ||
    "https://api.devnet.solana.com";

  const kpPath = process.env.AUTHORITY_SIGNER_KEYPAIR;
  if (!kpPath) {
    console.error("AUTHORITY_SIGNER_KEYPAIR is required");
    process.exit(1);
  }

  const newTeamTreasuryStr = process.env.NEW_TEAM_TREASURY_PUBKEY;
  if (!newTeamTreasuryStr) {
    console.error("NEW_TEAM_TREASURY_PUBKEY is required");
    process.exit(1);
  }

  const authoritySigner = loadKeypair(kpPath);
  const newTeamTreasury = new PublicKey(newTeamTreasuryStr);
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

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fetchFa = () => (program.account as any).futarchyAuthority.fetch(futarchyPda);

  const faBefore = await fetchFa();
  const onChainAuthority = faBefore.authority as PublicKey;
  if (!onChainAuthority.equals(authoritySigner.publicKey)) {
    console.error(
      `AUTHORITY_SIGNER_KEYPAIR pubkey ${authoritySigner.publicKey.toBase58()} must match ` +
        `futarchy_authority.authority ${onChainAuthority.toBase58()}`
    );
    process.exit(1);
  }

  const recBefore = faBefore.recipients as {
    futarchyTreasury: PublicKey;
    buybacksVault: PublicKey;
    teamTreasury: PublicKey;
  };

  console.log("RPC:", rpc);
  console.log("Omnipair program:", OMNIPAIR_PROGRAM_ID.toBase58());
  console.log("futarchy_authority:", futarchyPda.toBase58());
  console.log("authority_signer:", authoritySigner.publicKey.toBase58());
  console.log("Current recipients (before update):");
  console.log(JSON.stringify(recipientsRow(recBefore), null, 2));
  console.log("NEW_TEAM_TREASURY_PUBKEY:", newTeamTreasury.toBase58());

  if (newTeamTreasury.equals(recBefore.teamTreasury)) {
    console.error("NEW_TEAM_TREASURY_PUBKEY matches current team_treasury; nothing to do.");
    process.exit(1);
  }

  const sig = await program.methods
    .updateRevenueRecipients({
      futarchyTreasury: null,
      buybacksVault: null,
      teamTreasury: newTeamTreasury,
    })
    .accounts({
      authoritySigner: authoritySigner.publicKey,
      futarchyAuthority: futarchyPda,
      systemProgram: SystemProgram.programId,
    })
    .rpc();

  console.log("update_revenue_recipients tx signature:", sig);

  const faAfter = await fetchFa();
  const recAfter = faAfter.recipients as typeof recBefore;
  console.log("Recipients (after update):");
  console.log(JSON.stringify(recipientsRow(recAfter), null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
