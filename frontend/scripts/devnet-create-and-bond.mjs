/**
 * Devnet smoke: create a Tales token and buy until 5 SOL graduation.
 *
 * Usage (from frontend/):
 *   node --env-file=.env.local scripts/devnet-create-and-bond.mjs
 *
 * Uses ~/.config/solana/id.json as payer.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import anchor from "@coral-xyz/anchor";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
} from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";

const { BN, AnchorProvider, Program, Wallet } = anchor;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const RPC =
  process.env.NEXT_PUBLIC_SOLANA_RPC_URL || "https://api.devnet.solana.com";
const PROGRAM_ID = new PublicKey(
  process.env.NEXT_PUBLIC_PROGRAM_ID ||
    "72bwK5ffBy2vRTu694L8WtQ6xaXYA8ePJtxB34fnV2wv"
);
const GRADUATION_SOL = Number(process.env.NEXT_PUBLIC_GRADUATION_SOL || "5");
const GRADUATION_LAMPORTS = BigInt(Math.round(GRADUATION_SOL * 1e9));
const METADATA_PROGRAM_ID = new PublicKey(
  "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s"
);

function loadKeypair() {
  const p = path.join(process.env.HOME, ".config/solana/id.json");
  const secret = JSON.parse(fs.readFileSync(p, "utf8"));
  return Keypair.fromSecretKey(Uint8Array.from(secret));
}

function loadIdl() {
  return JSON.parse(
    fs.readFileSync(
      path.join(ROOT, "src/lib/idl/higher_launchpad.json"),
      "utf8"
    )
  );
}

function pda(seeds) {
  return PublicKey.findProgramAddressSync(seeds, PROGRAM_ID);
}

async function confirm(connection, sig) {
  const start = Date.now();
  while (Date.now() - start < 90_000) {
    const { value } = await connection.getSignatureStatuses([sig], {
      searchTransactionHistory: true,
    });
    const st = value[0];
    if (st?.err) throw new Error(JSON.stringify(st.err));
    if (st?.confirmationStatus === "confirmed" || st?.confirmationStatus === "finalized") {
      return;
    }
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error(`confirm timeout ${sig}`);
}

async function main() {
  const payer = loadKeypair();
  const connection = new Connection(RPC, "confirmed");
  const wallet = new Wallet(payer);
  const provider = new AnchorProvider(connection, wallet, {
    commitment: "confirmed",
  });
  const idl = loadIdl();
  idl.address = PROGRAM_ID.toBase58();
  const program = new Program(idl, provider);

  const bal = await connection.getBalance(payer.publicKey);
  console.log("payer", payer.publicKey.toBase58());
  console.log("balance", (bal / 1e9).toFixed(4), "SOL");
  console.log("program", PROGRAM_ID.toBase58());
  console.log("graduation target", GRADUATION_SOL, "SOL");

  if (bal < (GRADUATION_SOL + 1) * 1e9) {
    throw new Error("Need more than graduation+1 SOL on payer");
  }

  const mint = Keypair.generate();
  const [tokenState] = pda([Buffer.from("token_state"), mint.publicKey.toBuffer()]);
  const [mintAuthority] = pda([
    Buffer.from("mint_authority"),
    mint.publicKey.toBuffer(),
  ]);
  const [solVault] = pda([Buffer.from("sol_vault"), mint.publicKey.toBuffer()]);
  const [platform] = pda([Buffer.from("platform")]);
  const [metadata] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("metadata"),
      METADATA_PROGRAM_ID.toBuffer(),
      mint.publicKey.toBuffer(),
    ],
    METADATA_PROGRAM_ID
  );
  const tokenVault = getAssociatedTokenAddressSync(
    mint.publicKey,
    solVault,
    true
  );

  const name = `Tale${Date.now().toString().slice(-6)}`;
  const symbol = `T${Date.now().toString().slice(-4)}`;
  console.log("\n=== createToken ===", name, symbol, mint.publicKey.toBase58());

  const createSig = await program.methods
    .createToken({
      name,
      symbol,
      uri: "https://tales.fun/metadata/devnet-test.json",
      creatorFeeRecipient: payer.publicKey,
    })
    .accountsPartial({
      mint: mint.publicKey,
      mintAuthority,
      solVault,
      tokenVault,
      tokenState,
      metadata,
      platform,
      creator: payer.publicKey,
      rent: SYSVAR_RENT_PUBKEY,
      systemProgram: SystemProgram.programId,
      tokenProgram: TOKEN_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      metadataProgram: METADATA_PROGRAM_ID,
    })
    .signers([mint])
    .rpc();
  await confirm(connection, createSig);
  console.log("created", createSig);

  // Persist to API if local server is up (best-effort)
  try {
    const res = await fetch("http://localhost:3000/api/tokens", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mint: mint.publicKey.toBase58(),
        name,
        symbol,
        creator: payer.publicKey.toBase58(),
        creator_fee_recipient: payer.publicKey.toBase58(),
        phase: "bonding",
        uri: "https://tales.fun/metadata/devnet-test.json",
      }),
    });
    console.log("api/tokens", res.status);
  } catch (e) {
    console.warn("api persist skipped", e.message);
  }

  const buyerAta = getAssociatedTokenAddressSync(
    mint.publicKey,
    payer.publicKey
  );
  const [feeEscrow] = pda([
    Buffer.from("fee_escrow"),
    mint.publicKey.toBuffer(),
  ]);

  let state = await program.account.tokenState.fetch(tokenState);
  let raised = BigInt(state.solRaised.toString());
  console.log("\n=== buy until graduation === start raised", Number(raised) / 1e9);

  let buyRound = 0;
  while (raised < GRADUATION_LAMPORTS) {
    buyRound += 1;
    const remaining = GRADUATION_LAMPORTS - raised;
    // buy in ~1 SOL chunks (gross), last chunk slightly over remaining to cover fees
    const chunk =
      remaining > 1_000_000_000n
        ? 1_050_000_000n
        : remaining + 80_000_000n; // +0.08 for creator fee headroom
    const solLamports = new BN(chunk.toString());
    const minTokensOut = new BN(1);

    console.log(
      `buy #${buyRound}: ${(Number(chunk) / 1e9).toFixed(3)} SOL (raised ${(Number(raised) / 1e9).toFixed(4)})`
    );

    const platformState = await program.account.platformState.fetch(platform);
    const feeRecipient = platformState.feeRecipient;

    const sig = await program.methods
      .buy(solLamports, minTokensOut)
      .accountsPartial({
        tokenState,
        mint: mint.publicKey,
        solVault,
        tokenVault,
        userTokenAccount: buyerAta,
        user: payer.publicKey,
        feeEscrow,
        mintAuthority,
        platform,
        platformFeeRecipient: feeRecipient,
        gammPoolPlaceholder: PublicKey.default,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      })
      .rpc();
    await confirm(connection, sig);

    state = await program.account.tokenState.fetch(tokenState);
    raised = BigInt(state.solRaised.toString());
    const phase =
      state.phase.graduated != null
        ? "graduated"
        : state.phase.readyToGraduate != null
          ? "ready_to_graduate"
          : "bonding";
    console.log(
      `  -> raised ${(Number(raised) / 1e9).toFixed(4)} SOL phase=${phase} sig=${sig.slice(0, 12)}…`
    );

    if (phase === "graduated" || phase === "ready_to_graduate") break;
    if (buyRound > 20) throw new Error("too many buys; abort");
  }

  state = await program.account.tokenState.fetch(tokenState);
  const phase =
    state.phase.graduated != null
      ? "graduated"
      : state.phase.readyToGraduate != null
        ? "ready_to_graduate"
        : "bonding";
  const gamm =
    state.gammPool && !state.gammPool.equals(PublicKey.default)
      ? state.gammPool.toBase58()
      : "(unset)";

  console.log("\n=== RESULT ===");
  console.log("mint", mint.publicKey.toBase58());
  console.log("token page", `http://localhost:3000/token/${mint.publicKey.toBase58()}`);
  console.log("sol_raised", Number(state.solRaised.toString()) / 1e9);
  console.log("phase", phase);
  console.log("gamm_pool", gamm);
  console.log(
    "vault SOL (real_sol_reserve)",
    Number(state.realSolReserve.toString()) / 1e9
  );
  console.log(
    "NOTE: Omnipair pair fee buffer target 0.25 SOL; deployed Omnipair create fee is ~0.2 SOL (deployer pays at bootstrap)."
  );
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
