/**
 * E2E: create Tales tokens with real Unsplash images, bond to graduation,
 * bootstrap Omnipair (Dusk on mainnet / V1 on devnet), lock LP at incinerator,
 * then sell tokens + unwrap WSOL to reclaim launch SOL.
 *
 * Usage (from frontend/):
 *   node --env-file=.env.local scripts/e2e-launch-with-images.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
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
const TMP = path.join(ROOT, ".e2e-tmp");

const RPC =
  process.env.NEXT_PUBLIC_SOLANA_RPC_URL || "https://api.devnet.solana.com";
const PROGRAM_ID = new PublicKey(
  process.env.NEXT_PUBLIC_PROGRAM_ID ||
    "72bwK5ffBy2vRTu694L8WtQ6xaXYA8ePJtxB34fnV2wv"
);
const GRADUATION_SOL = Number(process.env.NEXT_PUBLIC_GRADUATION_SOL || "0.5");
const GRADUATION_LAMPORTS = BigInt(Math.round(GRADUATION_SOL * 1e9));
const METADATA_PROGRAM_ID = new PublicKey(
  "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s"
);

const IMAGE_SOURCES = [
  {
    name: "Aurora Peak",
    ticker: "AURORA",
    url: "https://images.unsplash.com/photo-1469474968028-56623f02e42e?auto=format&fit=crop&w=800&h=800&q=80",
  },
  {
    name: "Nebula Drift",
    ticker: "NEBULA",
    url: "https://images.unsplash.com/photo-1419242902214-272b3f66ee7a?auto=format&fit=crop&w=800&h=800&q=80",
  },
  {
    name: "Canyon Ember",
    ticker: "CANYON",
    url: "https://images.unsplash.com/photo-1441974231531-c6227db76b6e?auto=format&fit=crop&w=800&h=800&q=80",
  },
  {
    name: "Tide Mirror",
    ticker: "TIDE",
    url: "https://images.unsplash.com/photo-1505142468610-359e7d316be0?auto=format&fit=crop&w=800&h=800&q=80",
  },
  {
    name: "Frost Ridge",
    ticker: "FROST",
    url: "https://images.unsplash.com/photo-1519681393784-d120267933ba?auto=format&fit=crop&w=800&h=800&q=80",
  },
  {
    name: "Volt Horizon",
    ticker: "VOLT",
    url: "https://images.unsplash.com/photo-1451187580459-43490279c0fa?auto=format&fit=crop&w=800&h=800&q=80",
  },
];

function loadPayer() {
  return Keypair.fromSecretKey(
    Uint8Array.from(
      JSON.parse(
        fs.readFileSync(
          path.join(process.env.HOME, ".config/solana/id.json"),
          "utf8"
        )
      )
    )
  );
}

function loadIdl() {
  return JSON.parse(
    fs.readFileSync(path.join(ROOT, "src/lib/idl/higher_launchpad.json"), "utf8")
  );
}

function pda(seeds) {
  return PublicKey.findProgramAddressSync(seeds, PROGRAM_ID);
}

async function confirm(connection, sig) {
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
    ) {
      return;
    }
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error(`confirm timeout ${sig}`);
}

async function downloadImage(url, dest) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`image download failed ${res.status}`);
  fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
}

async function uploadViaPinata(imagePath, meta) {
  const jwt = process.env.PINATA_JWT;
  if (!jwt) throw new Error("PINATA_JWT missing");

  const imgForm = new FormData();
  imgForm.append(
    "file",
    new Blob([fs.readFileSync(imagePath)], { type: "image/jpeg" }),
    path.basename(imagePath)
  );
  const imgRes = await fetch("https://api.pinata.cloud/pinning/pinFileToIPFS", {
    method: "POST",
    headers: { Authorization: `Bearer ${jwt}` },
    body: imgForm,
  });
  const imgJson = await imgRes.json();
  if (!imgRes.ok) throw new Error(`pin image: ${JSON.stringify(imgJson)}`);
  const imageUri = `https://gateway.pinata.cloud/ipfs/${imgJson.IpfsHash}`;

  const metaRes = await fetch("https://api.pinata.cloud/pinning/pinJSONToIPFS", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${jwt}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      name: meta.name,
      symbol: meta.ticker,
      description: meta.description,
      image: imageUri,
    }),
  });
  const metaJson = await metaRes.json();
  if (!metaRes.ok) throw new Error(`pin meta: ${JSON.stringify(metaJson)}`);
  return {
    uri: `https://gateway.pinata.cloud/ipfs/${metaJson.IpfsHash}`,
    imageUrl: imageUri,
  };
}

async function main() {
  fs.mkdirSync(TMP, { recursive: true });
  const payer = loadPayer();
  const connection = new Connection(RPC, "confirmed");
  const idl = loadIdl();
  idl.address = PROGRAM_ID.toBase58();
  const program = new Program(
    idl,
    new AnchorProvider(connection, new Wallet(payer), {
      commitment: "confirmed",
    })
  );

  const bal = await connection.getBalance(payer.publicKey);
  console.log("payer", payer.publicKey.toBase58(), (bal / 1e9).toFixed(4), "SOL");
  console.log("program", PROGRAM_ID.toBase58());
  console.log("graduation", GRADUATION_SOL, "SOL");
  // Headroom: create fees + buys + sell tx fees. Keep low for cheap E2E loops.
  if (bal < (GRADUATION_SOL + 0.4) * 1e9) {
    throw new Error(`Need graduation+0.4 SOL on payer (have ${(bal / 1e9).toFixed(4)})`);
  }

  const count = Number(process.env.E2E_TOKEN_COUNT || "2");
  const offset = Number(process.env.E2E_IMAGE_OFFSET || "0");
  for (const pick of IMAGE_SOURCES.slice(offset, offset + count)) {
    const suffix = Date.now().toString().slice(-4);
    const name = `${pick.name} ${suffix}`;
    const ticker = `${pick.ticker.slice(0, 6)}${suffix}`.slice(0, 10);
    console.log("\n===", name, ticker, "===");

    const imgPath = path.join(TMP, `${ticker}.jpg`);
    await downloadImage(pick.url, imgPath);
    const { uri, imageUrl } = await uploadViaPinata(imgPath, {
      name,
      ticker,
      description: `${name}. Tales E2E launch with real art.`,
    });
    console.log("  image", imageUrl);
    console.log("  uri", uri);

    const mint = Keypair.generate();
    const [tokenState] = pda([
      Buffer.from("token_state"),
      mint.publicKey.toBuffer(),
    ]);
    const [mintAuthority] = pda([
      Buffer.from("mint_authority"),
      mint.publicKey.toBuffer(),
    ]);
    const [solVault] = pda([Buffer.from("sol_vault"), mint.publicKey.toBuffer()]);
    const [platform] = pda([Buffer.from("platform")]);
    const [feeEscrow] = pda([
      Buffer.from("fee_escrow"),
      mint.publicKey.toBuffer(),
    ]);
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

    const createSig = await program.methods
      .createToken({
        name,
        symbol: ticker,
        uri,
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
    console.log("  created", mint.publicKey.toBase58(), createSig.slice(0, 12));

    try {
      await fetch("http://localhost:3000/api/tokens", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mint: mint.publicKey.toBase58(),
          name,
          symbol: ticker,
          creator: payer.publicKey.toBase58(),
          creator_fee_recipient: payer.publicKey.toBase58(),
          phase: "bonding",
          uri,
          image_url: imageUrl,
          description: `${name}. Tales E2E launch with real art.`,
          total_supply: 1_000_000_000_000_000,
        }),
      });
    } catch (e) {
      console.warn("  api persist skipped", e.message);
    }

    const buyerAta = getAssociatedTokenAddressSync(
      mint.publicKey,
      payer.publicKey
    );
    let state = await program.account.tokenState.fetch(tokenState);
    let raised = BigInt(state.solRaised.toString());
    let buyRound = 0;
    while (raised < GRADUATION_LAMPORTS) {
      buyRound += 1;
      const remaining = GRADUATION_LAMPORTS - raised;
      // Overshoot threshold slightly so same-tx graduation fires.
      const pad = remaining > 200_000_000n ? 20_000_000n : 15_000_000n;
      const chunk =
        remaining > 250_000_000n ? 260_000_000n : remaining + pad;
      console.log(
        `  buy #${buyRound}: ${(Number(chunk) / 1e9).toFixed(3)} SOL (raised ${(Number(raised) / 1e9).toFixed(4)})`
      );
      const platformState = await program.account.platformState.fetch(platform);
      const sig = await program.methods
        .buy(new BN(chunk.toString()), new BN(1))
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
          platformFeeRecipient: platformState.feeRecipient,
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
        `    -> raised ${(Number(raised) / 1e9).toFixed(4)} phase=${phase}`
      );
      if (phase !== "bonding") break;
      if (buyRound > 20) throw new Error("too many buys");
    }

    console.log("  bootstrapping with platform keeper…");
    const tsxBin = path.join(ROOT, "node_modules", ".bin", "tsx");
    const boot = spawnSync(
      tsxBin,
      [
        "--env-file=.env.local",
        "scripts/devnet-bootstrap-mint.ts",
        mint.publicKey.toBase58(),
      ],
      { cwd: ROOT, encoding: "utf8", timeout: 400_000, env: process.env }
    );
    process.stdout.write(boot.stdout || "");
    if (boot.status !== 0) {
      process.stderr.write(boot.stderr || "");
      throw new Error(`bootstrap failed for ${mint.publicKey.toBase58()}`);
    }

    console.log("  selling tokens + unwrapping WSOL to reclaim SOL…");
    const sell = spawnSync(
      tsxBin,
      [
        "--env-file=.env.local",
        "scripts/devnet-sell-and-unwrap.ts",
        mint.publicKey.toBase58(),
      ],
      { cwd: ROOT, encoding: "utf8", timeout: 180_000, env: process.env }
    );
    process.stdout.write(sell.stdout || "");
    if (sell.status !== 0) {
      process.stderr.write(sell.stderr || "");
      console.warn("  sell/reclaim failed (non-fatal)", mint.publicKey.toBase58());
    }

    // Index Omnipair swaps from chain → trades table (charts/volume).
    console.log("  indexing on-chain Omnipair swaps…");
    const idx = spawnSync(
      tsxBin,
      ["--env-file=.env.local", "scripts/devnet-index-omnipair-trades.ts"],
      { cwd: ROOT, encoding: "utf8", timeout: 180_000, env: process.env }
    );
    process.stdout.write(idx.stdout || "");
    if (idx.status !== 0) {
      process.stderr.write(idx.stderr || "");
      console.warn("  indexer failed (non-fatal)");
    }

    try {
      state = await program.account.tokenState.fetch(tokenState);
      const balAfter = await connection.getBalance(payer.publicKey);
      console.log("  RESULT", {
        mint: mint.publicKey.toBase58(),
        page: `http://localhost:3000/token/${mint.publicKey.toBase58()}`,
        phase:
          state.phase.graduated != null
            ? "graduated"
            : state.phase.readyToGraduate != null
              ? "ready_to_graduate"
              : "bonding",
        market: state.gammPool?.equals?.(PublicKey.default)
          ? "(unset)"
          : state.gammPool?.toBase58?.(),
        image: imageUrl,
        payerSol: Number((balAfter / 1e9).toFixed(4)),
      });
    } catch (e) {
      console.warn("  RESULT fetch failed (non-fatal)", e?.message || e);
      console.log("  RESULT", {
        mint: mint.publicKey.toBase58(),
        page: `http://localhost:3000/token/${mint.publicKey.toBase58()}`,
        image: imageUrl,
      });
    }
  }

  console.log("\nE2E finished");
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
