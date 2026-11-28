/**
 * Launch "talesfun test" with the Tales logo, bond → graduate → Omnipair bootstrap,
 * then market-make over a long window so many 1m candles form (devnet stress).
 *
 * Usage (from frontend/):
 *   npx tsx --env-file=.env.local scripts/devnet-talesfun-test-stress.ts
 *
 * Env:
 *   STRESS_MINUTES=45     how long to MM after graduation (default 45)
 *   STRESS_ROUNDS=0       if >0, cap rounds instead of using duration
 *   SKIP_LAUNCH=1         skip create/bond/bootstrap; use STRESS_MINT=
 *   STRESS_MINT=<base58>
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
  Transaction,
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
import { fetchOmnipairPoolSnapshot } from "../src/lib/omnipairPoolState";
import { sendOmnipairSwapTx } from "../src/lib/omnipairSwap";
import { upsertLocalTrade } from "../src/lib/localTradeStore";
import { priceSolFromRaw } from "../src/lib/utils";

const ROOT = path.resolve(__dirname, "..");
const TMP = path.join(ROOT, ".e2e-tmp");
const LOGO = path.join(ROOT, "public", "tales-mark.png");
const METADATA_PROGRAM_ID = new PublicKey(
  "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s"
);

const RPC =
  process.env.NEXT_PUBLIC_SOLANA_RPC_URL || "https://api.devnet.solana.com";
const GRADUATION_SOL = Number(process.env.NEXT_PUBLIC_GRADUATION_SOL || "0.5");
const GRADUATION_LAMPORTS = BigInt(Math.round(GRADUATION_SOL * 1e9));
const STRESS_MINUTES = Math.max(
  5,
  Number(process.env.STRESS_MINUTES || "45")
);
const STRESS_ROUNDS = Math.max(0, Number(process.env.STRESS_ROUNDS || "0"));

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function log(...args: unknown[]) {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}]`, ...args);
}

function isTransientRpcError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return /blockhash not found|block height exceeded|timed out|429|fetch failed|ECONNRESET|socket hang up|node is behind|Too many requests/i.test(
    msg
  );
}

async function withRpcRetry<T>(
  label: string,
  fn: () => Promise<T>,
  attempts = 5
): Promise<T> {
  let last: unknown;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      if (!isTransientRpcError(e) || i === attempts) throw e;
      const wait = 800 * i + Math.floor(Math.random() * 700);
      log(`${label} retry ${i}/${attempts} after transient RPC error`, wait + "ms");
      await sleep(wait);
    }
  }
  throw last;
}

function loadPayer(): Keypair {
  return Keypair.fromSecretKey(
    Uint8Array.from(
      JSON.parse(
        fs.readFileSync(
          path.join(process.env.HOME!, ".config/solana/id.json"),
          "utf8"
        )
      )
    )
  );
}

function loadIdl(): Record<string, unknown> {
  return JSON.parse(
    fs.readFileSync(
      path.join(ROOT, "src/lib/idl/higher_launchpad.json"),
      "utf8"
    )
  );
}

function pda(seeds: Buffer[]): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(seeds, PROGRAM_ID);
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
    ) {
      return;
    }
    await sleep(400);
  }
  throw new Error(`confirm timeout ${sig}`);
}

async function uploadLogoViaPinata(
  imagePath: string,
  meta: { name: string; ticker: string; description: string }
): Promise<{ uri: string; imageUrl: string }> {
  const jwt = process.env.PINATA_JWT;
  if (!jwt) throw new Error("PINATA_JWT missing");

  const imgForm = new FormData();
  imgForm.append(
    "file",
    new Blob([fs.readFileSync(imagePath)], { type: "image/png" }),
    "tales-mark.png"
  );
  const imgRes = await fetch("https://api.pinata.cloud/pinning/pinFileToIPFS", {
    method: "POST",
    headers: { Authorization: `Bearer ${jwt}` },
    body: imgForm,
  });
  const imgJson = (await imgRes.json()) as { IpfsHash?: string };
  if (!imgRes.ok || !imgJson.IpfsHash) {
    throw new Error(`pin image: ${JSON.stringify(imgJson)}`);
  }
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
  const metaJson = (await metaRes.json()) as { IpfsHash?: string };
  if (!metaRes.ok || !metaJson.IpfsHash) {
    throw new Error(`pin meta: ${JSON.stringify(metaJson)}`);
  }
  return {
    uri: `https://gateway.pinata.cloud/ipfs/${metaJson.IpfsHash}`,
    imageUrl: imageUri,
  };
}

async function tokenUiBalance(
  connection: Connection,
  mint: PublicKey,
  owner: PublicKey
): Promise<number> {
  const ata = getAssociatedTokenAddressSync(mint, owner);
  const bal = await connection
    .getTokenAccountBalance(ata, "confirmed")
    .catch(() => null);
  return Number(bal?.value.uiAmountString ?? "0");
}

async function launchAndGraduate(
  connection: Connection,
  payer: Keypair
): Promise<{ mint: string; imageUrl: string; name: string; ticker: string }> {
  if (!fs.existsSync(LOGO)) throw new Error(`missing logo ${LOGO}`);
  fs.mkdirSync(TMP, { recursive: true });

  const name = "talesfun test";
  const ticker = "TALESFUN";
  log("pinning Tales logo…");
  const { uri, imageUrl } = await uploadLogoViaPinata(LOGO, {
    name,
    ticker,
    description:
      "talesfun test — Tales launchpad stress token with real market-making on Devnet.",
  });
  log("image", imageUrl);
  log("uri", uri);

  const idl = loadIdl() as { address?: string };
  idl.address = PROGRAM_ID.toBase58();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const program = new Program(
    idl as any,
    new AnchorProvider(connection, new Wallet(payer), {
      commitment: "confirmed",
    })
  );

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

  log("createToken", name, ticker, mint.publicKey.toBase58());
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
  log("created", createSig.slice(0, 16));

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
        description:
          "talesfun test — Tales launchpad stress token with real market-making on Devnet.",
        total_supply: 1_000_000_000_000_000,
      }),
    });
  } catch (e) {
    log("api persist skipped", e instanceof Error ? e.message : e);
  }

  const buyerAta = getAssociatedTokenAddressSync(
    mint.publicKey,
    payer.publicKey
  );

  // Bonding market-make: several smaller buys with pauses (simulate real flow).
  let state = await program.account.tokenState.fetch(tokenState);
  let raised = BigInt(state.solRaised.toString());
  let buyRound = 0;
  log("bonding toward", GRADUATION_SOL, "SOL");

  while (raised < GRADUATION_LAMPORTS) {
    buyRound += 1;
    const remaining = GRADUATION_LAMPORTS - raised;
    // Varied chunk sizes to look like organic buys.
    const want =
      remaining > 180_000_000n
        ? BigInt(Math.floor((0.05 + Math.random() * 0.09) * 1e9))
        : remaining + 15_000_000n;
    const chunk = want > remaining + 20_000_000n ? remaining + 15_000_000n : want;

    const balBefore = await tokenUiBalance(
      connection,
      mint.publicKey,
      payer.publicKey
    );
    log(
      `bond buy #${buyRound}: ${(Number(chunk) / 1e9).toFixed(3)} SOL (raised ${(Number(raised) / 1e9).toFixed(4)})`
    );

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const platformState = await (program.account as any).platformState.fetch(
      platform
    );
    const sig = await withRpcRetry(`bond buy #${buyRound}`, () =>
      program.methods
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
        .rpc()
    );
    await confirm(connection, sig);

    const balAfter = await tokenUiBalance(
      connection,
      mint.publicKey,
      payer.publicKey
    );
    const tokGot = Math.max(0, balAfter - balBefore);
    const solUi = Number(chunk) / 1e9;
    const tokRaw = BigInt(Math.floor(tokGot * 1e6));
    upsertLocalTrade({
      mint: mint.publicKey.toBase58(),
      signature: sig,
      side: "buy",
      sol_amount_raw: chunk.toString(),
      token_amount_raw: tokRaw.toString(),
      timestamp: new Date().toISOString(),
      wallet: payer.publicKey.toBase58(),
      price_sol:
        tokGot > 0
          ? solUi / tokGot
          : priceSolFromRaw(chunk.toString(), tokRaw.toString()),
      source: "bonding",
    });

    state = await program.account.tokenState.fetch(tokenState);
    raised = BigInt(state.solRaised.toString());
    const phase =
      state.phase.graduated != null
        ? "graduated"
        : state.phase.readyToGraduate != null
          ? "ready_to_graduate"
          : "bonding";
    log(`  -> raised ${(Number(raised) / 1e9).toFixed(4)} phase=${phase}`);

    // Occasional bonding sell while still bonding (buy-biased by default for demo fills).
    const sellP = Math.min(
      0.9,
      Math.max(0, Number(process.env.BOND_SELL_P ?? "0.2"))
    );
    if (phase === "bonding" && balAfter > 100_000 && Math.random() < sellP) {
      try {
        const sellFrac = 0.08 + Math.random() * 0.12;
        const sellUi = balAfter * sellFrac;
        const sellRaw = new BN(Math.floor(sellUi * 1e6).toString());
        const minSolOut = new BN(1);
        log(`bond sell #${buyRound}: ${sellUi.toFixed(0)} tok`);
        const sellSig = await withRpcRetry(`bond sell #${buyRound}`, () =>
          program.methods
            .sell(sellRaw, minSolOut)
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
            .rpc()
        );
        await confirm(connection, sellSig);
        const balAfterSell = await tokenUiBalance(
          connection,
          mint.publicKey,
          payer.publicKey
        );
        const tokSold = Math.max(0, balAfter - balAfterSell);
        upsertLocalTrade({
          mint: mint.publicKey.toBase58(),
          signature: sellSig,
          side: "sell",
          sol_amount_raw: "0",
          token_amount_raw: BigInt(Math.floor(tokSold * 1e6)).toString(),
          timestamp: new Date().toISOString(),
          wallet: payer.publicKey.toBase58(),
          price_sol: 0,
          source: "bonding",
        });
        state = await program.account.tokenState.fetch(tokenState);
        raised = BigInt(state.solRaised.toString());
      } catch (e) {
        log("bond sell skipped", e instanceof Error ? e.message : e);
      }
    }

    if (phase !== "bonding") break;
    if (buyRound > 80) throw new Error("too many bonding buys");
    // Space bonding fills so early candles aren't a single burst.
    const sleepBase = Math.max(
      500,
      Number(process.env.BOND_SLEEP_MS ?? "3000")
    );
    await sleep(sleepBase + Math.floor(Math.random() * sleepBase));
  }

  log("bootstrapping Omnipair…");
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

  return {
    mint: mint.publicKey.toBase58(),
    imageUrl,
    name,
    ticker,
  };
}

/** Continue bonding → bootstrap for an existing mint (resume after partial launch). */
async function resumeBondBootstrap(
  connection: Connection,
  payer: Keypair,
  mintStr: string
): Promise<void> {
  const mint = new PublicKey(mintStr);
  const idl = loadIdl() as { address?: string };
  idl.address = PROGRAM_ID.toBase58();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const program = new Program(
    idl as any,
    new AnchorProvider(connection, new Wallet(payer), {
      commitment: "confirmed",
    })
  );

  const [tokenState] = pda([Buffer.from("token_state"), mint.toBuffer()]);
  const [mintAuthority] = pda([
    Buffer.from("mint_authority"),
    mint.toBuffer(),
  ]);
  const [solVault] = pda([Buffer.from("sol_vault"), mint.toBuffer()]);
  const [platform] = pda([Buffer.from("platform")]);
  const [feeEscrow] = pda([Buffer.from("fee_escrow"), mint.toBuffer()]);
  const tokenVault = getAssociatedTokenAddressSync(mint, solVault, true);
  const buyerAta = getAssociatedTokenAddressSync(mint, payer.publicKey);

  let state = await program.account.tokenState.fetch(tokenState);
  let phase =
    state.phase.graduated != null
      ? "graduated"
      : state.phase.readyToGraduate != null
        ? "ready_to_graduate"
        : "bonding";
  let raised = BigInt(state.solRaised.toString());
  log("resume mint", mintStr, "phase", phase, "raised", Number(raised) / 1e9);

  let buyRound = 0;
  while (phase === "bonding" && raised < GRADUATION_LAMPORTS) {
    buyRound += 1;
    const remaining = GRADUATION_LAMPORTS - raised;
    const want =
      remaining > 180_000_000n
        ? BigInt(Math.floor((0.06 + Math.random() * 0.1) * 1e9))
        : remaining + 15_000_000n;
    const chunk =
      want > remaining + 20_000_000n ? remaining + 15_000_000n : want;

    const balBefore = await tokenUiBalance(connection, mint, payer.publicKey);
    log(
      `resume buy #${buyRound}: ${(Number(chunk) / 1e9).toFixed(3)} SOL (raised ${(Number(raised) / 1e9).toFixed(4)})`
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const platformState = await (program.account as any).platformState.fetch(
      platform
    );
    const sig = await withRpcRetry(`resume buy #${buyRound}`, () =>
      program.methods
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
        .rpc()
    );
    await confirm(connection, sig);
    const balAfter = await tokenUiBalance(connection, mint, payer.publicKey);
    const tokGot = Math.max(0, balAfter - balBefore);
    upsertLocalTrade({
      mint: mintStr,
      signature: sig,
      side: "buy",
      sol_amount_raw: chunk.toString(),
      token_amount_raw: BigInt(Math.floor(tokGot * 1e6)).toString(),
      timestamp: new Date().toISOString(),
      wallet: payer.publicKey.toBase58(),
      price_sol: tokGot > 0 ? Number(chunk) / 1e9 / tokGot : 0,
      source: "bonding",
    });
    state = await program.account.tokenState.fetch(tokenState);
    raised = BigInt(state.solRaised.toString());
    phase =
      state.phase.graduated != null
        ? "graduated"
        : state.phase.readyToGraduate != null
          ? "ready_to_graduate"
          : "bonding";
    log(`  -> raised ${(Number(raised) / 1e9).toFixed(4)} phase=${phase}`);
    if (phase !== "bonding") break;
    if (buyRound > 40) throw new Error("too many resume buys");
    await sleep(5_000 + Math.floor(Math.random() * 8_000));
  }

  state = await program.account.tokenState.fetch(tokenState);
  const token = tokenStateToToken(state, mintStr);
  if (token.phase === "graduated" && !token.gammPool) {
    log("bootstrapping Omnipair…");
    const tsxBin = path.join(ROOT, "node_modules", ".bin", "tsx");
    const boot = spawnSync(
      tsxBin,
      ["--env-file=.env.local", "scripts/devnet-bootstrap-mint.ts", mintStr],
      { cwd: ROOT, encoding: "utf8", timeout: 400_000, env: process.env }
    );
    process.stdout.write(boot.stdout || "");
    if (boot.status !== 0) {
      process.stderr.write(boot.stderr || "");
      throw new Error(`bootstrap failed for ${mintStr}`);
    }
  } else if (token.gammPool) {
    log("already bootstrapped", token.gammPool);
  } else {
    throw new Error(`token not graduated after resume (phase=${token.phase})`);
  }
}

async function marketMakeStress(
  connection: Connection,
  payer: Keypair,
  mintStr: string
) {
  const mint = new PublicKey(mintStr);
  const program = getReadOnlyProgram(connection);
  const [pdaAddr] = getTokenStatePDA(mint);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const state = await (program.account as any).tokenState.fetch(pdaAddr);
  const token = tokenStateToToken(state, mintStr);
  if (!token.gammPool) throw new Error("no gamm pool after bootstrap");

  const wallet = {
    publicKey: payer.publicKey,
    signTransaction: async <T extends Transaction>(tx: T) => {
      tx.partialSign(payer);
      return tx;
    },
    signAllTransactions: async <T extends Transaction>(txs: T[]) => {
      for (const t of txs) t.partialSign(payer);
      return txs;
    },
  };

  const deadline = Date.now() + STRESS_MINUTES * 60_000;
  const maxRounds = STRESS_ROUNDS > 0 ? STRESS_ROUNDS : 10_000;
  log("MM stress start", {
    mint: mintStr,
    pool: token.gammPool,
    minutes: STRESS_MINUTES,
    maxRounds,
    page: `http://localhost:3000/token/${mintStr}`,
  });

  let i = 0;
  let buys = 0;
  let sells = 0;
  let fails = 0;

  while (i < maxRounds && Date.now() < deadline) {
    i += 1;
    try {
      const snap = await fetchOmnipairPoolSnapshot(
        connection,
        token.gammPool,
        mintStr,
        payer.publicKey
      );
      if (!snap.ok) {
        log(`#${i} snapshot fail`, snap.message);
        fails += 1;
        await sleep(3000);
        continue;
      }

      // Varied sizes: mostly small, occasional larger "whale" prints.
      const whale = Math.random() < 0.12;
      const buySol = whale
        ? 0.035 + Math.random() * 0.04
        : 0.006 + Math.random() * 0.018;

      const buy = await withRpcRetry(`#${i} buy`, () =>
        sendOmnipairSwapTx({
          connection,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          wallet: wallet as any,
          snapshot: snap.data,
          side: "buy",
          amountUi: buySol,
          slippagePercent: 12,
        })
      );
      upsertLocalTrade({
        mint: mintStr,
        signature: buy.signature,
        side: "buy",
        sol_amount_raw: buy.fill.sol_amount_raw,
        token_amount_raw: buy.fill.token_amount_raw,
        timestamp: buy.fill.timestamp,
        wallet: payer.publicKey.toBase58(),
        price_sol: buy.fill.price_sol,
        source: "omnipair",
      });
      buys += 1;
      log(
        `#${i} BUY`,
        buySol.toFixed(4),
        "SOL",
        `@ ${buy.fill.price_sol.toExponential(3)}`,
        buy.signature.slice(0, 12)
      );

      // Gap inside the minute so buy+sell can land in same or adjacent candles.
      await sleep(4_000 + Math.floor(Math.random() * 8_000));

      const ui = await tokenUiBalance(connection, mint, payer.publicKey);
      if (ui > 80) {
        // Sell 20–55% most of the time; sometimes hold (skip sell) for inventory drift.
        if (Math.random() < 0.82) {
          const sellUi = Math.min(ui * (0.2 + Math.random() * 0.35), ui * 0.55);
          const snap2 = await fetchOmnipairPoolSnapshot(
            connection,
            token.gammPool,
            mintStr,
            payer.publicKey
          );
          if (snap2.ok) {
            const sell = await withRpcRetry(`#${i} sell`, () =>
              sendOmnipairSwapTx({
                connection,
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                wallet: wallet as any,
                snapshot: snap2.data,
                side: "sell",
                amountUi: sellUi,
                slippagePercent: 12,
              })
            );
            upsertLocalTrade({
              mint: mintStr,
              signature: sell.signature,
              side: "sell",
              sol_amount_raw: sell.fill.sol_amount_raw,
              token_amount_raw: sell.fill.token_amount_raw,
              timestamp: sell.fill.timestamp,
              wallet: payer.publicKey.toBase58(),
              price_sol: sell.fill.price_sol,
              source: "omnipair",
            });
            sells += 1;
            log(
              `#${i} SELL`,
              sellUi.toFixed(2),
              "tok",
              `@ ${sell.fill.price_sol.toExponential(3)}`,
              sell.signature.slice(0, 12)
            );
          }
        } else {
          log(`#${i} hold (no sell) bal=${ui.toFixed(0)}`);
        }
      } else {
        log(`#${i} skip sell (bal ${ui.toFixed(2)})`);
      }
    } catch (e) {
      fails += 1;
      log(`#${i} FAIL`, e instanceof Error ? e.message : e);
    }

    const remainMin = ((deadline - Date.now()) / 60_000).toFixed(1);
    if (i % 5 === 0) {
      log(`progress rounds=${i} buys=${buys} sells=${sells} fails=${fails} eta=${remainMin}m`);
    }

    // Space rounds across ~35–90s so many distinct 1m buckets fill.
    const gap = 35_000 + Math.floor(Math.random() * 55_000);
    await sleep(gap);
  }

  log("MM stress done", { rounds: i, buys, sells, fails, mint: mintStr });
}

async function main() {
  const payer = loadPayer();
  const connection = new Connection(RPC, "confirmed");
  const bal = await connection.getBalance(payer.publicKey);
  log("payer", payer.publicKey.toBase58(), (bal / 1e9).toFixed(4), "SOL");
  log("graduation", GRADUATION_SOL, "SOL");
  log("stress window", STRESS_MINUTES, "minutes");

  if (bal < (GRADUATION_SOL + 0.6) * 1e9) {
    throw new Error(
      `Need graduation+0.6 SOL on payer (have ${(bal / 1e9).toFixed(4)})`
    );
  }

  let mintStr = process.env.STRESS_MINT?.trim() || "";
  let imageUrl = "";
  let name = "talesfun test";
  let ticker = "TALESFUN";

  if (mintStr) {
    log("resuming existing mint", mintStr);
    await resumeBondBootstrap(connection, payer, mintStr);
  } else if (process.env.SKIP_LAUNCH === "1") {
    throw new Error("SKIP_LAUNCH=1 requires STRESS_MINT=");
  } else {
    const launched = await launchAndGraduate(connection, payer);
    mintStr = launched.mint;
    imageUrl = launched.imageUrl;
    name = launched.name;
    ticker = launched.ticker;
  }

  // Persist mint for resume.
  const outPath = path.join(TMP, "talesfun-test-mint.json");
  fs.writeFileSync(
    outPath,
    JSON.stringify(
      {
        mint: mintStr,
        name,
        ticker,
        imageUrl,
        page: `http://localhost:3000/token/${mintStr}`,
        startedAt: new Date().toISOString(),
      },
      null,
      2
    )
  );
  log("saved", outPath);
  log("TOKEN PAGE", `http://localhost:3000/token/${mintStr}`);

  await marketMakeStress(connection, payer, mintStr);

  // Final on-chain index pass.
  const tsxBin = path.join(ROOT, "node_modules", ".bin", "tsx");
  spawnSync(
    tsxBin,
    ["--env-file=.env.local", "scripts/devnet-index-omnipair-trades.ts"],
    { cwd: ROOT, encoding: "utf8", timeout: 180_000, env: process.env }
  );

  log("STRESS COMPLETE", {
    mint: mintStr,
    page: `http://localhost:3000/token/${mintStr}`,
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
