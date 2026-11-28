/**
 * Finish bonding an existing mint to NEXT_PUBLIC_GRADUATION_SOL with buy-only fills,
 * then Omnipair bootstrap.
 *
 *   MINT=... npx tsx --env-file=.env.local scripts/devnet-finish-bond-mint.ts
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
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
import { BN, AnchorProvider, Program, Wallet } from "@coral-xyz/anchor";
import {
  getTokenStatePDA,
  getReadOnlyProgram,
  tokenStateToToken,
  PROGRAM_ID,
} from "../src/lib/program";

const ROOT = path.resolve(__dirname, "..");
const GRADUATION_SOL = Number(process.env.NEXT_PUBLIC_GRADUATION_SOL || "5");
const GRADUATION_LAMPORTS = BigInt(Math.round(GRADUATION_SOL * 1e9));

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function confirm(connection: Connection, sig: string) {
  const start = Date.now();
  while (Date.now() - start < 120_000) {
    const { value } = await connection.getSignatureStatuses([sig], {
      searchTransactionHistory: true,
    });
    const st = value[0];
    if (st?.err) throw new Error(JSON.stringify(st.err));
    if (
      st?.confirmationStatus === "confirmed" ||
      st?.confirmationStatus === "finalized"
    )
      return;
    await sleep(400);
  }
  throw new Error(`confirm timeout ${sig}`);
}

async function main() {
  const mintStr =
    process.env.MINT ||
    process.argv[2] ||
    (() => {
      throw new Error("MINT required");
    })();
  const connection = new Connection(
    process.env.NEXT_PUBLIC_SOLANA_RPC_URL || "https://api.devnet.solana.com",
    "confirmed"
  );
  const payer = Keypair.fromSecretKey(
    Uint8Array.from(
      JSON.parse(
        fs.readFileSync(
          path.join(process.env.HOME!, ".config/solana/id.json"),
          "utf8"
        )
      )
    )
  );
  const community = Keypair.fromSecretKey(
    Uint8Array.from(
      JSON.parse(
        fs.readFileSync(
          path.join(process.env.HOME!, ".config/solana/phantom.json"),
          "utf8"
        )
      )
    )
  );

  // Top up payer from EXC if needed
  const needRaised = GRADUATION_LAMPORTS;
  const ro = getReadOnlyProgram(connection);
  const mint = new PublicKey(mintStr);
  const [tokenState] = getTokenStatePDA(mint);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let state = await (ro.account as any).tokenState.fetch(tokenState);
  let t = tokenStateToToken(state, mintStr);
  console.log({
    mint: mintStr,
    phase: t.phase,
    raised: t.solRaised,
    target: GRADUATION_SOL,
    id: (await connection.getBalance(payer.publicKey)) / 1e9,
    ph: (await connection.getBalance(community.publicKey)) / 1e9,
  });

  if (t.phase === "bonding") {
    const remaining = Number(needRaised) / 1e9 - t.solRaised;
    const wantPay = remaining + 0.15;
    const idBal = (await connection.getBalance(payer.publicKey)) / 1e9;
    if (idBal < wantPay) {
      const need = Math.ceil((wantPay - idBal) * 1e9);
      const phBal = await connection.getBalance(community.publicKey);
      if (phBal < need + 40_000_000) {
        throw new Error(
          `need ${wantPay.toFixed(2)} on id to finish; have id=${idBal.toFixed(2)} ph=${(phBal / 1e9).toFixed(2)}`
        );
      }
      const { Transaction, sendAndConfirmTransaction, SystemProgram: SP } =
        await import("@solana/web3.js");
      const tx = new Transaction().add(
        SP.transfer({
          fromPubkey: community.publicKey,
          toPubkey: payer.publicKey,
          lamports: need,
        })
      );
      await sendAndConfirmTransaction(connection, tx, [community], {
        commitment: "confirmed",
      });
      console.log("topped id", need / 1e9);
    }

    const idl = JSON.parse(
      fs.readFileSync(
        path.join(ROOT, "src/lib/idl/higher_launchpad.json"),
        "utf8"
      )
    ) as { address?: string };
    idl.address = PROGRAM_ID.toBase58();
    const program = new Program(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      idl as any,
      new AnchorProvider(connection, new Wallet(payer), {
        commitment: "confirmed",
      })
    );

    const [solVault] = PublicKey.findProgramAddressSync(
      [Buffer.from("sol_vault"), mint.toBuffer()],
      PROGRAM_ID
    );
    const [mintAuthority] = PublicKey.findProgramAddressSync(
      [Buffer.from("mint_authority"), mint.toBuffer()],
      PROGRAM_ID
    );
    const [platform] = PublicKey.findProgramAddressSync(
      [Buffer.from("platform")],
      PROGRAM_ID
    );
    const [feeEscrow] = PublicKey.findProgramAddressSync(
      [Buffer.from("fee_escrow"), mint.toBuffer()],
      PROGRAM_ID
    );
    const tokenVault = getAssociatedTokenAddressSync(mint, solVault, true);
    const buyerAta = getAssociatedTokenAddressSync(mint, payer.publicKey);

    let raised = BigInt(state.solRaised.toString());
    let n = 0;
    while (raised < GRADUATION_LAMPORTS) {
      n++;
      const remaining = GRADUATION_LAMPORTS - raised;
      // Large final chunks — buy only, no sells
      const chunk =
        remaining > 400_000_000n
          ? 350_000_000n + BigInt(Math.floor(Math.random() * 80_000_000))
          : remaining + 20_000_000n;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const platformState = await (program.account as any).platformState.fetch(
        platform
      );
      console.log(
        `finish buy #${n}: ${(Number(chunk) / 1e9).toFixed(3)} (raised ${(Number(raised) / 1e9).toFixed(4)})`
      );
      const sig = await program.methods
        .buy(new BN(chunk.toString()), new BN(1))
        .accountsPartial({
          tokenState,
          mint,
          solVault,
          tokenVault,
          userTokenAccount: buyerAta,
          user: payer.publicKey,
          feeEscrow,
          mintAuthority,
          platform,
          platformFeeRecipient: platformState.feeRecipient,
          gammPoolPlaceholder: PublicKey.default,
          systemProgram: SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        })
        .rpc();
      await confirm(connection, sig);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      state = await (program.account as any).tokenState.fetch(tokenState);
      raised = BigInt(state.solRaised.toString());
      t = tokenStateToToken(state, mintStr);
      console.log(`  -> raised ${t.solRaised.toFixed(4)} phase=${t.phase}`);
      if (t.phase !== "bonding") break;
      if (n > 40) throw new Error("finish bond: too many buys");
      await sleep(800);
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  state = await (ro.account as any).tokenState.fetch(tokenState);
  t = tokenStateToToken(state, mintStr);
  console.log("pre-bootstrap", { phase: t.phase, raised: t.solRaised, gamm: t.gammPool });

  if (t.phase === "graduated" && !t.gammPool) {
    const tsxBin = path.join(ROOT, "node_modules", ".bin", "tsx");
    const boot = spawnSync(
      tsxBin,
      ["--env-file=.env.local", "scripts/devnet-bootstrap-mint.ts", mintStr],
      { cwd: ROOT, encoding: "utf8", timeout: 400_000, env: process.env }
    );
    process.stdout.write(boot.stdout || "");
    process.stderr.write(boot.stderr || "");
    if (boot.status !== 0) throw new Error("bootstrap failed");
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  state = await (ro.account as any).tokenState.fetch(tokenState);
  t = tokenStateToToken(state, mintStr);
  const meta = {
    mint: mintStr,
    name: t.name || "talesfun test",
    ticker: t.ticker || "TALESFUN",
    imageUrl:
      "https://gateway.pinata.cloud/ipfs/QmUSWd6KNDYYPnMqRvgK5eNSSNdXDiRnRnWVkHXbLXTzyG",
    gammPool: t.gammPool,
    phase: t.phase,
    page: `http://localhost:3000/token/${mintStr}`,
    startedAt: new Date().toISOString(),
    graduationSol: GRADUATION_SOL,
  };
  fs.mkdirSync(path.join(ROOT, ".e2e-tmp"), { recursive: true });
  fs.writeFileSync(
    path.join(ROOT, ".e2e-tmp/talesfun-test-mint.json"),
    JSON.stringify(meta, null, 2)
  );
  console.log("saved", meta);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
