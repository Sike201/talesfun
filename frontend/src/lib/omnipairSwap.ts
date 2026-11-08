import { Program, AnchorProvider, BN } from "@coral-xyz/anchor";
import {
  ComputeBudgetProgram,
  Connection,
  PublicKey,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import bs58 from "bs58";
import type { AnchorWallet } from "@solana/wallet-adapter-react";
import {
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountInstruction,
  createSyncNativeInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { IDL as OmnipairIdl } from "@omnipair/program-interface";
import type { Omnipair } from "@omnipair/program-interface";
import {
  OMNIPAIR_PROGRAM_ID,
  deriveOmnipairFutarchyAuthority,
  deriveOmnipairReserveVault,
  omnipairEventAuthorityPda,
} from "./omnipairProgram";
import {
  fetchOmnipairPoolSnapshot,
  type OmnipairPoolSnapshot,
} from "./omnipairPoolState";
import { priceSolFromRawDecimals } from "./utils";

const CU_SWAP = 600_000;
const WSOL_MINT_B58 = NATIVE_MINT.toBase58();

/** Keep native SOL for fees, wrap, and rent when using "100%" on buy. */
const BUY_SOL_BUFFER_LAMPORTS = 20_000_000;

function signatureFromSignedTransaction(signed: Transaction): string | null {
  const buf = signed.signature;
  if (!buf || buf.length === 0) return null;
  return bs58.encode(buf);
}

function errorTextDeep(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

/** Parse `Transaction <sig> resulted` from SendTransactionError.message when present. */
function signatureFromSendErrorMessage(e: unknown): string | null {
  const msg = errorTextDeep(e);
  const m = msg.match(
    /Transaction\s+([1-9A-HJ-NP-Za-km-z]{64,128})\s+resulted/i
  );
  return m?.[1] ?? null;
}

function isDuplicateOrAlreadyProcessedError(e: unknown): boolean {
  const t = errorTextDeep(e);
  return (
    /already been processed/i.test(t) ||
    /AlreadyProcessed/i.test(t) ||
    /duplicate signature/i.test(t)
  );
}

async function pollSignatureLanded(
  connection: Connection,
  signature: string,
  timeoutMs = 90_000
): Promise<{ ok: true } | { ok: false; err?: unknown }> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const { value } = await connection.getSignatureStatuses([signature], {
      searchTransactionHistory: true,
    });
    const st = value[0];
    if (st == null) {
      await new Promise(r => setTimeout(r, 400));
      continue;
    }
    if (st.err) {
      return { ok: false, err: st.err };
    }
    const c = st.confirmationStatus;
    if (c === "confirmed" || c === "finalized") {
      return { ok: true };
    }
    await new Promise(r => setTimeout(r, 400));
  }
  return { ok: false };
}

/**
 * Confirm without `connection.confirmTransaction` (WebSocket subscription).
 * Sells were freezing ~20s when RPC logged `ws error: undefined` while the tx
 * had already landed — polling via HTTP avoids that stall.
 */
async function confirmTransactionPollingOnly(
  connection: Connection,
  signature: string,
  timeoutMs = 60_000
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const { value } = await connection.getSignatureStatuses([signature], {
      searchTransactionHistory: true,
    });
    const st = value[0];
    if (st == null) {
      await new Promise(r => setTimeout(r, 350));
      continue;
    }
    if (st.err) {
      throw new Error(
        `Transaction failed on-chain: ${JSON.stringify(st.err)}`
      );
    }
    const c = st.confirmationStatus;
    if (c === "confirmed" || c === "finalized") {
      return;
    }
    await new Promise(r => setTimeout(r, 350));
  }
  throw new Error("Omnipair swap: confirmation timed out (RPC polling)");
}

function slipBpsFromPercent(slippagePercent: number): number {
  const n = Number(slippagePercent);
  if (!Number.isFinite(n) || n < 0) return 100;
  return Math.min(10_000, Math.max(0, Math.round(n * 100)));
}

function applySlippageFloor(raw: bigint, slipBps: number): bigint {
  if (raw <= BigInt(0)) return BigInt(0);
  return (raw * BigInt(10_000 - slipBps)) / BigInt(10_000);
}

/**
 * Constant-product SOL out for **sell** (project token → WSOL), same invariant as xy=k vaults:
 * Δy = y * Δx / (x + Δx) with x = project reserve (raw), y = WSOL reserve (raw), Δx = token in (raw).
 *
 * Using **mid price** `spot * amountUi` (reserve ratio × size) **overstates** Δy vs this curve, so
 * `minAmountOut` derived from spot was often **above** what the program pays → SlippageExceeded.
 */
function quoteSellSolOutCpmm(
  reserveProjectRaw: bigint,
  reserveSolRaw: bigint,
  amountInProjectRaw: bigint
): bigint {
  if (amountInProjectRaw <= BigInt(0)) return BigInt(0);
  const denom = reserveProjectRaw + amountInProjectRaw;
  if (denom <= BigInt(0)) return BigInt(0);
  return (reserveSolRaw * amountInProjectRaw) / denom;
}

async function mintOwnerProgram(
  connection: Connection,
  mint: PublicKey
): Promise<PublicKey> {
  const info = await connection.getAccountInfo(mint, "confirmed");
  if (!info) throw new Error(`Mint account not found: ${mint.toBase58()}`);
  if (info.owner.equals(TOKEN_2022_PROGRAM_ID)) return TOKEN_2022_PROGRAM_ID;
  return TOKEN_PROGRAM_ID;
}

function getOmnipairProgram(connection: Connection, wallet: AnchorWallet): Program<Omnipair> {
  const omnipairIdlForCluster = {
    ...OmnipairIdl,
    address: OMNIPAIR_PROGRAM_ID.toBase58(),
  };
  return new Program(
    omnipairIdlForCluster as Omnipair,
    new AnchorProvider(connection, wallet, { commitment: "confirmed" })
  );
}

export type OmnipairSwapSide = "buy" | "sell";

/** Quantities for `trades` / chart (raw lamports + raw token base units). */
export type OmnipairSwapFill = {
  timestamp: string;
  sol_amount_raw: string;
  token_amount_raw: string;
  price_sol: number;
};

export type OmnipairSwapTxResult = {
  signature: string;
  fill: OmnipairSwapFill;
};

function bigintAbs(n: bigint): bigint {
  return n < BigInt(0) ? -n : n;
}

function buildFallbackOmnipairFill(
  side: OmnipairSwapSide,
  amountUi: number,
  snapshot: OmnipairPoolSnapshot,
  amountIn: bigint
): OmnipairSwapFill {
  const ts = new Date().toISOString();
  const dec = snapshot.projectTokenDecimals;
  const spot = snapshot.spotPriceSol;
  if (side === "buy") {
    const sol_amount_raw = amountIn.toString();
    const tokEst = BigInt(
      Math.floor((amountUi / spot) * 10 ** dec)
    );
    const token_amount_raw = tokEst.toString();
    const price_sol = priceSolFromRawDecimals(sol_amount_raw, token_amount_raw, dec);
    return { timestamp: ts, sol_amount_raw, token_amount_raw, price_sol };
  }
  const token_amount_raw = amountIn.toString();
  const solEst = BigInt(Math.floor(amountUi * spot * 1e9));
  const sol_amount_raw = solEst.toString();
  const price_sol = priceSolFromRawDecimals(sol_amount_raw, token_amount_raw, dec);
  return { timestamp: ts, sol_amount_raw, token_amount_raw, price_sol };
}

/**
 * Read user's WSOL + project token ATA balance deltas from a confirmed swap tx.
 */
export async function fetchOmnipairSwapFillFromTx(
  connection: Connection,
  signature: string,
  owner: PublicKey,
  projectMint: PublicKey
): Promise<OmnipairSwapFill | null> {
  const ownerB58 = owner.toBase58();
  const projB58 = projectMint.toBase58();

  for (let attempt = 0; attempt < 6; attempt++) {
    const tx = await connection.getParsedTransaction(signature, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
    if (tx?.meta && !tx.meta.err) {
      const pre = tx.meta.preTokenBalances ?? [];
      const post = tx.meta.postTokenBalances ?? [];

      const bal = (rows: typeof pre) => {
        const m = new Map<string, string>();
        for (const b of rows) {
          if (!b?.mint || b.owner !== ownerB58) continue;
          m.set(b.mint, b.uiTokenAmount?.amount ?? "0");
        }
        return m;
      };
      const preM = bal(pre);
      const postM = bal(post);
      const mints = new Set([...preM.keys(), ...postM.keys()]);

      const projDec = readProjectDecimalsFromPostBalances(post, projB58);

      let solDelta = BigInt(0);
      let tokDelta = BigInt(0);

      for (const mint of mints) {
        const a0 = BigInt(preM.get(mint) ?? "0");
        const a1 = BigInt(postM.get(mint) ?? "0");
        const d = a1 - a0;
        if (mint === WSOL_MINT_B58) solDelta += d;
        else if (mint === projB58) tokDelta += d;
      }

      const solAbs = bigintAbs(solDelta);
      const tokAbs = bigintAbs(tokDelta);

      if (solAbs > BigInt(0) && tokAbs > BigInt(0)) {
        const blockTime = tx.blockTime;
        const timestamp =
          typeof blockTime === "number"
            ? new Date(blockTime * 1000).toISOString()
            : new Date().toISOString();
        const sol_amount_raw = solAbs.toString();
        const token_amount_raw = tokAbs.toString();
        const price_sol = priceSolFromRawDecimals(
          sol_amount_raw,
          token_amount_raw,
          projDec
        );
        return {
          timestamp,
          sol_amount_raw,
          token_amount_raw,
          price_sol,
        };
      }
    }
    await new Promise(r => setTimeout(r, 500));
  }
  return null;
}

function readProjectDecimalsFromPostBalances(
  post: ReadonlyArray<{
    mint?: string;
    uiTokenAmount?: { decimals?: number };
  }>,
  projB58: string
): number {
  for (const b of post) {
    if (b?.mint === projB58 && typeof b.uiTokenAmount?.decimals === "number") {
      return b.uiTokenAmount.decimals;
    }
  }
  return 6;
}

async function buildOmnipairSwapFill(
  connection: Connection,
  signature: string,
  owner: PublicKey,
  projectMint: PublicKey,
  side: OmnipairSwapSide,
  amountUi: number,
  snapshot: OmnipairPoolSnapshot,
  amountIn: bigint
): Promise<OmnipairSwapFill> {
  // Sell: skip getParsedTransaction retries — often slow or flaky vs buy; use
  // spot-based fallback so UI clears as soon as confirmation returns.
  if (side === "sell") {
    const fill = buildFallbackOmnipairFill(
      side,
      amountUi,
      snapshot,
      amountIn
    );
    console.info("[omnipair:swap] SELL: fill (fast fallback, skipped chain parse)", {
      signature,
      price_sol: fill.price_sol,
    });
    return fill;
  }

  const fromChain = await fetchOmnipairSwapFillFromTx(
    connection,
    signature,
    owner,
    projectMint
  );
  const fill =
    fromChain ?? buildFallbackOmnipairFill(side, amountUi, snapshot, amountIn);
  console.info("[omnipair:swap] fill for persist/chart", {
    signature,
    parsedFromTx: fromChain != null,
    price_sol: fill.price_sol,
  });
  return fill;
}

async function finalizeOmnipairSwapTx(
  connection: Connection,
  signature: string,
  owner: PublicKey,
  projectMint: PublicKey,
  side: OmnipairSwapSide,
  amountUi: number,
  snapshot: OmnipairPoolSnapshot,
  amountIn: bigint
): Promise<OmnipairSwapTxResult> {
  const fill = await buildOmnipairSwapFill(
    connection,
    signature,
    owner,
    projectMint,
    side,
    amountUi,
    snapshot,
    amountIn
  );
  return { signature, fill };
}

export type SendOmnipairSwapTxParams = {
  connection: Connection;
  wallet: AnchorWallet;
  snapshot: OmnipairPoolSnapshot;
  side: OmnipairSwapSide;
  /** Buy: SOL UI amount. Sell: project token UI amount. */
  amountUi: number;
  slippagePercent: number;
};

/**
 * Build and submit an Omnipair `swap` for this launchpad pool (WSOL ↔ project token).
 *
 * **Buy:** wraps SOL → WSOL ATA (`SystemProgram.transfer` + `syncNative`), swaps WSOL → token.
 * **Sell:** swaps token → WSOL; output stays in the wallet WSOL ATA (native SOL unwrap is optional / wallet UI).
 */
export async function sendOmnipairSwapTx(
  params: SendOmnipairSwapTxParams
): Promise<OmnipairSwapTxResult> {
  const { connection, wallet, snapshot, side, amountUi, slippagePercent } = params;
  const owner = wallet.publicKey;
  if (!owner) throw new Error("Wallet not connected");

  if (!(amountUi > 0) || !Number.isFinite(amountUi)) {
    throw new Error("Enter a valid amount");
  }

  const slipBps = slipBpsFromPercent(slippagePercent);
  const spot = snapshot.spotPriceSol;
  if (!(spot > 0) || !Number.isFinite(spot)) {
    throw new Error("Pool spot price unavailable; refresh and try again");
  }

  const pairPk = snapshot.pair;
  const projectMint = snapshot.projectMint;
  const tokenInMint =
    side === "buy" ? NATIVE_MINT : projectMint;
  const tokenOutMint =
    side === "buy" ? projectMint : NATIVE_MINT;

  const projectTokenProgram = await mintOwnerProgram(connection, projectMint);

  const userWsolAta = getAssociatedTokenAddressSync(
    NATIVE_MINT,
    owner,
    false,
    TOKEN_PROGRAM_ID
  );
  const userProjectAta = getAssociatedTokenAddressSync(
    projectMint,
    owner,
    false,
    projectTokenProgram
  );

  const userTokenIn = side === "buy" ? userWsolAta : userProjectAta;
  const userTokenOut = side === "buy" ? userProjectAta : userWsolAta;

  const program = getOmnipairProgram(connection, wallet);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pairAcct = await (program.account as any).pair.fetch(pairPk);
  const rateModel = pairAcct.rateModel as PublicKey;

  const [tokenInVault] = deriveOmnipairReserveVault(pairPk, tokenInMint);
  const [tokenOutVault] = deriveOmnipairReserveVault(pairPk, tokenOutMint);
  const [futarchyAuthority] = deriveOmnipairFutarchyAuthority();
  const eventAuthority = omnipairEventAuthorityPda();

  let amountIn: bigint;
  let minAmountOut: bigint;

   if (side === "buy") {
    amountIn = BigInt(Math.floor(amountUi * 1e9));
    if (amountIn <= BigInt(0)) throw new Error("SOL amount too small");
    const tokenOutUi = amountUi / spot;
    const expectedOut = BigInt(
      Math.floor(tokenOutUi * 10 ** snapshot.projectTokenDecimals)
    );
    if (expectedOut <= BigInt(0)) {
      throw new Error("Expected output too small; increase SOL amount");
    }
    minAmountOut = applySlippageFloor(expectedOut, slipBps);
    if (minAmountOut <= BigInt(0)) throw new Error("Min output after slippage is zero");
  } else {
    amountIn = BigInt(
      Math.floor(amountUi * 10 ** snapshot.projectTokenDecimals)
    );
    if (amountIn <= BigInt(0)) throw new Error("Token amount too small");

    const fresh = await fetchOmnipairPoolSnapshot(
      connection,
      pairPk.toBase58(),
      projectMint.toBase58(),
      null
    );
    if (!fresh.ok) {
      throw new Error(`Sell quote: could not refresh pool — ${fresh.message}`);
    }
    const q = fresh.data;
    const rProj = BigInt(q.reserveProjectRaw);
    const rSol = BigInt(q.reserveSolRaw);

    const expectedOut = quoteSellSolOutCpmm(rProj, rSol, amountIn);
    if (expectedOut <= BigInt(0)) {
      throw new Error("Expected SOL output too small (pool quote)");
    }
    minAmountOut = applySlippageFloor(expectedOut, slipBps);
    if (minAmountOut <= BigInt(0)) throw new Error("Min output after slippage is zero");

    const linearLamports = BigInt(Math.floor(amountUi * spot * 1e9));
    console.info("[omnipair:swap] SELL quote", {
      rawTokenIn: amountIn.toString(),
      reserveProjectRaw: q.reserveProjectRaw,
      reserveSolRaw: q.reserveSolRaw,
      cpmmQuotedSolOutLamports: expectedOut.toString(),
      linearSpotEstimateLamports: linearLamports.toString(),
      slippagePercent: slippagePercent,
      slippageBps: slipBps,
      minAmountOutLamports: minAmountOut.toString(),
      staleSpotPriceSol: spot,
      freshMidSpotSol: q.spotPriceSol,
    });
  }

  console.info("[omnipair:swap] path", {
    side,
    pair: pairPk.toBase58(),
    token0: snapshot.token0.toBase58(),
    token1: snapshot.token1.toBase58(),
    tokenIn: tokenInMint.toBase58(),
    tokenOut: tokenOutMint.toBase58(),
    userTokenIn: userTokenIn.toBase58(),
    userTokenOut: userTokenOut.toBase58(),
    amountIn: amountIn.toString(),
    minAmountOut: minAmountOut.toString(),
    slippageBps: slipBps,
  });

  const ixs = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: CU_SWAP }),
  ];

  if (!(await connection.getAccountInfo(userWsolAta, "confirmed"))) {
    ixs.push(
      createAssociatedTokenAccountInstruction(
        owner,
        userWsolAta,
        owner,
        NATIVE_MINT,
        TOKEN_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID
      )
    );
  }

  if (!(await connection.getAccountInfo(userProjectAta, "confirmed"))) {
    ixs.push(
      createAssociatedTokenAccountInstruction(
        owner,
        userProjectAta,
        owner,
        projectMint,
        projectTokenProgram,
        ASSOCIATED_TOKEN_PROGRAM_ID
      )
    );
  }

  if (side === "buy") {
    let existing = BigInt(0);
    try {
      const b = await connection.getTokenAccountBalance(userWsolAta, "confirmed");
      existing = BigInt(b.value.amount);
    } catch {
      existing = BigInt(0);
    }
    const need =
      amountIn > existing ? amountIn - existing : BigInt(0);
    if (need > BigInt(0)) {
      if (need > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new Error("SOL wrap amount too large for this client");
      }
      ixs.push(
        SystemProgram.transfer({
          fromPubkey: owner,
          toPubkey: userWsolAta,
          lamports: Number(need),
        })
      );
    }
    ixs.push(createSyncNativeInstruction(userWsolAta));
  }

  const swapIx = await program.methods
    .swap({
      amountIn: new BN(amountIn.toString()),
      minAmountOut: new BN(minAmountOut.toString()),
    })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .accounts({
      pair: pairPk,
      rateModel,
      futarchyAuthority,
      tokenInVault,
      tokenOutVault,
      userTokenInAccount: userTokenIn,
      userTokenOutAccount: userTokenOut,
      tokenInMint,
      tokenOutMint,
      user: owner,
      tokenProgram: TOKEN_PROGRAM_ID,
      token2022Program: TOKEN_2022_PROGRAM_ID,
      eventAuthority,
      program: OMNIPAIR_PROGRAM_ID,
    } as any)
    .instruction();

  ixs.push(swapIx);

  const { blockhash } = await connection.getLatestBlockhash("confirmed");
  const tx = new Transaction({
    feePayer: owner,
    recentBlockhash: blockhash,
  });
  tx.add(...ixs);

  if (side === "sell") {
    console.info("[omnipair:swap] SELL: submit started (sign next)", {
      amountUi,
      pair: pairPk.toBase58(),
    });
  }

  const signed = await wallet.signTransaction(tx);
  const recoveredSignature = signatureFromSignedTransaction(signed);

  if (side === "sell") {
    console.info("[omnipair:swap] SELL: wallet signed", {
      signature: recoveredSignature,
    });
  }

  let submittedSignature: string;
  try {
    submittedSignature = await connection.sendRawTransaction(signed.serialize(), {
      skipPreflight: false,
      maxRetries: 3,
    });
  } catch (e) {
    if (recoveredSignature && isDuplicateOrAlreadyProcessedError(e)) {
      console.warn("[omnipair:swap] duplicate/already-processed send path", {
        side,
        recoveredSignature,
        error: e instanceof Error ? e.message : e,
      });
      if (side === "sell") {
        console.warn(
          "[omnipair:swap] SELL: duplicate/already-processed — polling chain",
          { recoveredSignature }
        );
      }
      const landed = await pollSignatureLanded(connection, recoveredSignature);
      console.info("[omnipair:swap] duplicate path poll result", {
        recoveredSignature,
        landed: landed.ok,
        ...(!landed.ok && "err" in landed ? { err: landed.err } : {}),
      });
      if (landed.ok) {
        console.info("[omnipair:swap] tx treated as success (already on-chain)", {
          side,
          signature: recoveredSignature,
        });
        if (side === "sell") {
          console.info(
            "[omnipair:swap] SELL: duplicate path — final confirmation OK, finalizing",
            { signature: recoveredSignature }
          );
        }
        return finalizeOmnipairSwapTx(
          connection,
          recoveredSignature,
          owner,
          projectMint,
          side,
          amountUi,
          snapshot,
          amountIn
        );
      }
    }
    const sigFromErr = signatureFromSendErrorMessage(e);
    if (sigFromErr && isDuplicateOrAlreadyProcessedError(e)) {
      console.warn("[omnipair:swap] duplicate path (signature parsed from error message)", {
        signature: sigFromErr,
      });
      const landed = await pollSignatureLanded(connection, sigFromErr);
      console.info("[omnipair:swap] duplicate path poll result (from error message)", {
        signature: sigFromErr,
        landed: landed.ok,
      });
      if (landed.ok) {
        console.info("[omnipair:swap] tx treated as success", {
          side,
          signature: sigFromErr,
        });
        if (side === "sell") {
          console.info(
            "[omnipair:swap] SELL: duplicate path (from error message) OK, finalizing",
            { signature: sigFromErr }
          );
        }
        return finalizeOmnipairSwapTx(
          connection,
          sigFromErr,
          owner,
          projectMint,
          side,
          amountUi,
          snapshot,
          amountIn
        );
      }
    }
    throw e;
  }

  console.info("[omnipair:swap] tx submitted", { side, signature: submittedSignature });
  if (side === "sell") {
    console.info("[omnipair:swap] SELL: awaiting confirmation (HTTP poll, no WS)", {
      signature: submittedSignature,
    });
  }

  await confirmTransactionPollingOnly(connection, submittedSignature);

  console.info("[omnipair:swap] tx confirmed", {
    side,
    signature: submittedSignature,
  });
  if (side === "sell") {
    console.info("[omnipair:swap] SELL: confirmation result OK (polled)", {
      signature: submittedSignature,
    });
  }
  return finalizeOmnipairSwapTx(
    connection,
    submittedSignature,
    owner,
    projectMint,
    side,
    amountUi,
    snapshot,
    amountIn
  );
}

/** Max SOL (UI) user can spend on a buy after buffer, given current lamports balance. */
export function omnipairMaxBuySolUi(solBalanceLamports: number): number {
  const spendable = Math.max(0, solBalanceLamports - BUY_SOL_BUFFER_LAMPORTS);
  return spendable / 1e9;
}
