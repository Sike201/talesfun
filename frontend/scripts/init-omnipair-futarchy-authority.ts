/**
 * One-time Omnipair cluster bootstrap: `init_futarchy_authority`
 *
 * WHO CAN RUN THIS
 * ----------------
 * The `deployer` signer MUST be the **upgrade authority** of the Omnipair program on this cluster.
 * On-chain check (omnipair-rs): reads ProgramData, requires `deployer == upgrade_authority_address`.
 * You cannot initialize with a random wallet — only whoever holds that authority (Omnipair team for
 * the official binary, or YOU if you deployed your own Omnipair on devnet).
 *
 * OFFICIAL PROGRAM ID (mainnet + devnet docs)
 * -------------------------------------------
 * omnixgS8fnqHfCcTGKWj6JtKjzpJZ1Y5y9pyFkQDkYE
 *
 * MAINNET: futarchy_authority (2SMS1Y4…) usually already exists — run `solana account 2SMS1Y4EAyL2dQLpXD6VJCrNbQJ2eQ2pN3qYcX1vim3E -u mainnet-beta` to confirm.
 * DEVNET: If the program is not deployed at this id, or futarchy was never inited, you must either
 *   (a) get Omnipair to init devnet, or (b) deploy Omnipair yourself and run this with YOUR authority.
 *
 * REVENUE BPS
 * -----------
 * futarchy_treasury_bps + buybacks_vault_bps + team_treasury_bps MUST equal exactly 10_000.
 *
 * Usage (from repo `frontend/`):
 *   RPC_URL=https://api.devnet.solana.com \
 *   OMNIPAIR_PROGRAM_ID=<your deployed program id> \
 *   UPGRADE_AUTHORITY_KEYPAIR=$HOME/.config/solana/id.json \
 *   npx --yes tsx scripts/init-omnipair-futarchy-authority.ts
 *
 * Optional env (defaults: use authority pubkey for all three treasuries, equal thirds rounded):
 *   GOVERNANCE_AUTHORITY_PUBKEY - stored in FutarchyAuthority as `authority` (updater role)
 *   SWAP_BPS, INTEREST_BPS       - protocol fee caps (each <= 10000)
 *   FUTARCHY_TREASURY_PUBKEY, BUYBACKS_VAULT_PUBKEY, TEAM_TREASURY_PUBKEY
 *   FUTARCHY_TREASURY_BPS, BUYBACKS_VAULT_BPS, TEAM_TREASURY_BPS  - must sum to 10000
 */
import fs from "fs";
import path from "path";
import { Program, AnchorProvider, Wallet, type Idl } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";

const OFFICIAL_OMNIPAIR_PROGRAM =
  "omnixgS8fnqHfCcTGKWj6JtKjzpJZ1Y5y9pyFkQDkYE";

const BPF_LOADER_UPGRADEABLE = new PublicKey(
  "BPFLoaderUpgradeab1e11111111111111111111111"
);

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

type IdlJson = Record<string, unknown> & { instructions?: Record<string, unknown>[] };

/** Avoid `@omnipair/program-interface` package `exports` (no `require` condition; Node/tsx can reject imports). */
function loadOmnipairIdlFromDisk(): IdlJson {
  const idlPath = path.join(
    process.cwd(),
    "node_modules/@omnipair/program-interface/dist/idl.json"
  );
  return JSON.parse(fs.readFileSync(idlPath, "utf8")) as IdlJson;
}

/**
 * Published IDL hardcodes `program_data` PDA seed = official Omnipair program id.
 * For a self-deployed program, Anchor must derive ProgramData under BPF upgradeable loader
 * with seed = **this** program id, or ConstraintSeeds fails on-chain.
 */
function patchInitFutarchyProgramDataSeed(idl: IdlJson, programId: PublicKey): void {
  const ix = idl.instructions?.find(
    (i) => i.name === "init_futarchy_authority"
  );
  if (!ix) throw new Error("IDL missing init_futarchy_authority");
  const accounts = ix.accounts as Record<string, unknown>[] | undefined;
  const acc = accounts?.find((a) => a.name === "program_data");
  const pda = acc?.pda as { seeds?: { kind: string; value?: number[] }[] } | undefined;
  const seed0 = pda?.seeds?.[0];
  if (seed0?.kind !== "const" || !Array.isArray(seed0.value)) {
    throw new Error("IDL init_futarchy_authority program_data: unexpected PDA seed shape");
  }
  seed0.value = Array.from(programId.toBytes());
}

function loadKeypair(jsonPath: string): Keypair {
  const abs = path.resolve(jsonPath);
  const secret = JSON.parse(fs.readFileSync(abs, "utf8")) as number[];
  return Keypair.fromSecretKey(Uint8Array.from(secret));
}

function programDataAddress(programId: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [programId.toBuffer()],
    BPF_LOADER_UPGRADEABLE
  );
  return pda;
}

async function main() {
  const rpc =
    process.env.RPC_URL ||
    process.env.SOLANA_RPC_URL ||
    "https://api.devnet.solana.com";
  const kpPath =
    process.env.UPGRADE_AUTHORITY_KEYPAIR ||
    process.env.DEPLOYER_KEYPAIR ||
    path.join(process.env.HOME || "", ".config/solana/id.json");

  const deployer = loadKeypair(kpPath);
  const connection = new Connection(rpc, "confirmed");
  const OMNIPAIR_PROGRAM_ID = omnipairProgramIdFromEnv();

  const programInfo = await connection.getAccountInfo(OMNIPAIR_PROGRAM_ID);
  if (!programInfo) {
    console.error(
      `No program at ${OMNIPAIR_PROGRAM_ID.toBase58()} on ${rpc}. Deploy Omnipair on this cluster first, or use an RPC where it is deployed.`
    );
    process.exit(1);
  }

  const show = await connection.getParsedAccountInfo(OMNIPAIR_PROGRAM_ID);
  const parsed = show.value?.data;
  if (
    typeof parsed === "object" &&
    parsed &&
    "parsed" in parsed &&
    parsed.parsed &&
    typeof parsed.parsed === "object" &&
    "info" in parsed.parsed
  ) {
    const info = parsed.parsed.info as { authority?: string };
    if (info.authority && info.authority !== deployer.publicKey.toBase58()) {
      console.warn(
        `Warning: Program upgrade authority is ${info.authority}, but your keypair is ${deployer.publicKey.toBase58()}. The transaction will fail unless they match.`
      );
    }
  }

  const futarchyPda = futarchyAuthorityPda(OMNIPAIR_PROGRAM_ID);
  const existing = await connection.getAccountInfo(futarchyPda);
  if (existing) {
    console.log(
      `futarchy_authority already exists at ${futarchyPda.toBase58()}. Nothing to do.`
    );
    process.exit(0);
  }

  const programData = programDataAddress(OMNIPAIR_PROGRAM_ID);
  const gov =
    process.env.GOVERNANCE_AUTHORITY_PUBKEY || deployer.publicKey.toBase58();
  const governancePk = new PublicKey(gov);

  const swapBps = Number(process.env.SWAP_BPS ?? 100);
  const interestBps = Number(process.env.INTEREST_BPS ?? 100);

  let ftBps = process.env.FUTARCHY_TREASURY_BPS
    ? Number(process.env.FUTARCHY_TREASURY_BPS)
    : 3400;
  let bbBps = process.env.BUYBACKS_VAULT_BPS
    ? Number(process.env.BUYBACKS_VAULT_BPS)
    : 3300;
  let ttBps = process.env.TEAM_TREASURY_BPS
    ? Number(process.env.TEAM_TREASURY_BPS)
    : 3300;
  const sum = ftBps + bbBps + ttBps;
  if (sum !== 10_000) {
    console.error(
      `Revenue bps must sum to 10000, got ${sum} (futarchy ${ftBps}, buybacks ${bbBps}, team ${ttBps})`
    );
    process.exit(1);
  }

  const futarchyTreasury = new PublicKey(
    process.env.FUTARCHY_TREASURY_PUBKEY || deployer.publicKey.toBase58()
  );
  const buybacksVault = new PublicKey(
    process.env.BUYBACKS_VAULT_PUBKEY || deployer.publicKey.toBase58()
  );
  const teamTreasury = new PublicKey(
    process.env.TEAM_TREASURY_PUBKEY || deployer.publicKey.toBase58()
  );

  const wallet = new Wallet(deployer);
  const provider = new AnchorProvider(connection, wallet, {
    commitment: "confirmed",
  });
  const rawIdl = loadOmnipairIdlFromDisk();
  patchInitFutarchyProgramDataSeed(rawIdl, OMNIPAIR_PROGRAM_ID);
  const idl = { ...rawIdl, address: OMNIPAIR_PROGRAM_ID.toBase58() };
  const program = new Program(idl as Idl, provider);

  console.log("RPC:", rpc);
  console.log("Deployer (must be program upgrade authority):", deployer.publicKey.toBase58());
  console.log("futarchy_authority PDA:", futarchyPda.toBase58());
  console.log(
    "[init script] OMNIPAIR_PROGRAM_ID (runtime):",
    OMNIPAIR_PROGRAM_ID.toBase58()
  );
  console.log(
    "[init script] program_data PDA (BPF upgradeable loader, seed = program id):",
    programData.toBase58()
  );

  const sig = await program.methods
    .initFutarchyAuthority({
      authority: governancePk,
      swapBps,
      interestBps,
      futarchyTreasury,
      futarchyTreasuryBps: ftBps,
      buybacksVault,
      buybacksVaultBps: bbBps,
      teamTreasury,
      teamTreasuryBps: ttBps,
    })
    // Anchor resolves const-seed PDAs (`futarchy_authority`, `program_data`) and
    // fixed-address `system_program` from the IDL — only the signer must be supplied.
    .accounts({
      deployer: deployer.publicKey,
    })
    .rpc();

  console.log("init_futarchy_authority tx:", sig);
  console.log("Done. You can retry launchpad bootstrap_omnipair_pool.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
