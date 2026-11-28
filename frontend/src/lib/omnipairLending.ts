/**
 * Omnipair V1 lending: add/remove collateral, borrow/repay.
 * Matches docs.omnipair.fi borrowing + recursive leverage (collateral → borrow → swap).
 */
import { Program, AnchorProvider, BN } from "@coral-xyz/anchor";
import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  type TransactionInstruction,
} from "@solana/web3.js";
import type { AnchorWallet } from "@solana/wallet-adapter-react";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  NATIVE_MINT,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction,
  createSyncNativeInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { IDL as OmnipairIdl, SEEDS } from "@omnipair/program-interface";
import type { Omnipair } from "@omnipair/program-interface";
import {
  OMNIPAIR_PROGRAM_ID,
  deriveOmnipairCollateralVault,
  deriveOmnipairFutarchyAuthority,
  deriveOmnipairReserveVault,
  omnipairEventAuthorityPda,
} from "./omnipairProgram";
import type { OmnipairPoolSnapshot } from "./omnipairPoolState";
import { buildOmnipairSwapIxs } from "./omnipairSwap";
import { clampLeverage, poolSafeCf } from "./poolMaxLeverage";
import { buildPlatformFeeTransferIx, PLATFORM_FEE_BPS } from "./platformFee";

const CU = 900_000;

function getProgram(connection: Connection, wallet: AnchorWallet): Program<Omnipair> {
  const idl = { ...OmnipairIdl, address: OMNIPAIR_PROGRAM_ID.toBase58() };
  return new Program(
    idl as Omnipair,
    new AnchorProvider(connection, wallet, { commitment: "confirmed" })
  );
}

export function deriveOmnipairUserPosition(
  pair: PublicKey,
  user: PublicKey,
  programId: PublicKey = OMNIPAIR_PROGRAM_ID
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [SEEDS.USER_POSITION, pair.toBuffer(), user.toBuffer()],
    programId
  );
}

async function mintTokenProgram(
  connection: Connection,
  mint: PublicKey
): Promise<PublicKey> {
  const info = await connection.getAccountInfo(mint, "confirmed");
  if (!info) throw new Error(`Mint missing: ${mint.toBase58()}`);
  return info.owner.equals(TOKEN_2022_PROGRAM_ID)
    ? TOKEN_2022_PROGRAM_ID
    : TOKEN_PROGRAM_ID;
}

async function sendTx(
  connection: Connection,
  wallet: AnchorWallet,
  ixs: Parameters<Transaction["add"]>[0][],
  label: string,
  opts?: { extraSigners?: Keypair[]; computeUnits?: number }
): Promise<string> {
  const tx = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitLimit({
      units: opts?.computeUnits ?? CU,
    }),
    ...ixs
  );
  tx.feePayer = wallet.publicKey;
  const { blockhash, lastValidBlockHeight } =
    await connection.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  if (opts?.extraSigners?.length) {
    tx.partialSign(...opts.extraSigners);
  }
  const signed = await wallet.signTransaction(tx);
  const sig = await connection.sendRawTransaction(signed.serialize(), {
    skipPreflight: false,
    maxRetries: 3,
  });
  await connection.confirmTransaction(
    { signature: sig, blockhash, lastValidBlockHeight },
    "confirmed"
  );
  console.info(`[omnipair:lending] ${label}`, sig);
  return sig;
}

async function buildAddCollateralIxs(params: {
  connection: Connection;
  wallet: AnchorWallet;
  snapshot: OmnipairPoolSnapshot;
  collateralMint: PublicKey;
  amountRaw: bigint;
}): Promise<TransactionInstruction[]> {
  const { connection, wallet, snapshot, collateralMint, amountRaw } = params;
  const owner = wallet.publicKey;
  if (!owner) throw new Error("Wallet not connected");
  if (amountRaw <= BigInt(0)) throw new Error("Amount too small");

  const pairPk = snapshot.pair;
  const program = getProgram(connection, wallet);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pairAcct = await (program.account as any).pair.fetch(pairPk);
  const rateModel = pairAcct.rateModel as PublicKey;
  const [userPosition] = deriveOmnipairUserPosition(pairPk, owner);
  const [collateralVault] = deriveOmnipairCollateralVault(pairPk, collateralMint);
  const [futarchyAuthority] = deriveOmnipairFutarchyAuthority();
  const eventAuthority = omnipairEventAuthorityPda();
  const tokenProgram = await mintTokenProgram(connection, collateralMint);
  const userAta = getAssociatedTokenAddressSync(
    collateralMint,
    owner,
    false,
    tokenProgram
  );

  const ixs: TransactionInstruction[] = [];
  if (collateralMint.equals(NATIVE_MINT)) {
    const fee = buildPlatformFeeTransferIx({
      from: owner,
      solUi: Number(amountRaw) / 1e9,
    });
    const bal = await connection.getBalance(owner, "confirmed");
    const feeLamports = fee?.feeLamports ?? BigInt(0);
    const need =
      Number(amountRaw) + Number(feeLamports) + 10_000_000; /* rent buffer */
    if (bal < need) {
      throw new Error(
        `Insufficient SOL for collateral+fee+rent (have ${(bal / 1e9).toFixed(4)}, need ~${(need / 1e9).toFixed(4)})`
      );
    }
    if (fee) {
      ixs.push(fee.ix);
      console.info("[platform-fee] add_collateral SOL skim", {
        bps: PLATFORM_FEE_BPS,
        feeLamports: fee.feeLamports.toString(),
      });
    }
    ixs.push(
      createAssociatedTokenAccountIdempotentInstruction(
        owner,
        userAta,
        owner,
        NATIVE_MINT,
        TOKEN_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID
      ),
      SystemProgram.transfer({
        fromPubkey: owner,
        toPubkey: userAta,
        lamports: Number(amountRaw),
      }),
      createSyncNativeInstruction(userAta)
    );
  } else {
    if (!(await connection.getAccountInfo(userAta, "confirmed"))) {
      throw new Error("No token balance to post as collateral");
    }
    const tokenUi =
      Number(amountRaw) / 10 ** snapshot.projectTokenDecimals;
    const notionalSol =
      snapshot.spotPriceSol > 0 ? tokenUi * snapshot.spotPriceSol : 0;
    const fee = buildPlatformFeeTransferIx({ from: owner, solUi: notionalSol });
    if (fee) {
      ixs.push(fee.ix);
      console.info("[platform-fee] add_collateral token skim (SOL)", {
        bps: PLATFORM_FEE_BPS,
        feeLamports: fee.feeLamports.toString(),
        notionalSol,
      });
    }
  }

  const ix = await program.methods
    .addCollateral({ amount: new BN(amountRaw.toString()) })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .accounts({
      pair: pairPk,
      rateModel,
      futarchyAuthority,
      userPosition,
      collateralVault,
      userCollateralTokenAccount: userAta,
      collateralTokenMint: collateralMint,
      user: owner,
      tokenProgram: TOKEN_PROGRAM_ID,
      token2022Program: TOKEN_2022_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
      eventAuthority,
      program: OMNIPAIR_PROGRAM_ID,
    } as any)
    .instruction();
  ixs.push(ix);
  return ixs;
}

/**
 * Deposit project tokens (or SOL) as collateral into the Omnipair pair position.
 */
export async function sendOmnipairAddCollateralTx(params: {
  connection: Connection;
  wallet: AnchorWallet;
  snapshot: OmnipairPoolSnapshot;
  /** Which side to post as collateral */
  collateralMint: PublicKey;
  /** Raw amount (lamports / token base units) */
  amountRaw: bigint;
}): Promise<string> {
  const ixs = await buildAddCollateralIxs(params);
  return sendTx(params.connection, params.wallet, ixs, "add_collateral");
}

async function buildBorrowIxs(params: {
  connection: Connection;
  wallet: AnchorWallet;
  snapshot: OmnipairPoolSnapshot;
  borrowMint: PublicKey;
  amountRaw: bigint;
  /** Keep borrowed WSOL in ATA (needed when same-tx swap will spend it). */
  keepWsolAta?: boolean;
}): Promise<TransactionInstruction[]> {
  const { connection, wallet, snapshot, borrowMint, amountRaw } = params;
  const owner = wallet.publicKey;
  if (!owner) throw new Error("Wallet not connected");
  if (amountRaw <= BigInt(0)) throw new Error("Borrow amount too small");

  const pairPk = snapshot.pair;
  const program = getProgram(connection, wallet);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pairAcct = await (program.account as any).pair.fetch(pairPk);
  const rateModel = pairAcct.rateModel as PublicKey;
  const [userPosition] = deriveOmnipairUserPosition(pairPk, owner);
  const [reserveVault] = deriveOmnipairReserveVault(pairPk, borrowMint);
  const [futarchyAuthority] = deriveOmnipairFutarchyAuthority();
  const eventAuthority = omnipairEventAuthorityPda();
  const tokenProgram = await mintTokenProgram(connection, borrowMint);
  const userAta = getAssociatedTokenAddressSync(
    borrowMint,
    owner,
    false,
    tokenProgram
  );

  const ixs: TransactionInstruction[] = [
    createAssociatedTokenAccountIdempotentInstruction(
      owner,
      userAta,
      owner,
      borrowMint,
      tokenProgram,
      ASSOCIATED_TOKEN_PROGRAM_ID
    ),
  ];

  if (borrowMint.equals(NATIVE_MINT)) {
    const fee = buildPlatformFeeTransferIx({
      from: owner,
      solUi: Number(amountRaw) / 1e9,
    });
    if (fee) {
      ixs.push(fee.ix);
      console.info("[platform-fee] borrow SOL skim", {
        bps: PLATFORM_FEE_BPS,
        feeLamports: fee.feeLamports.toString(),
      });
    }
  }

  const ix = await program.methods
    .borrow({ amount: new BN(amountRaw.toString()) })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .accounts({
      pair: pairPk,
      userPosition,
      rateModel,
      futarchyAuthority,
      reserveVault,
      userReserveTokenAccount: userAta,
      reserveTokenMint: borrowMint,
      user: owner,
      tokenProgram: TOKEN_PROGRAM_ID,
      token2022Program: TOKEN_2022_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
      eventAuthority,
      program: OMNIPAIR_PROGRAM_ID,
    } as any)
    .instruction();
  ixs.push(ix);

  // Unwrap WSOL unless a later same-tx swap will spend it as WSOL.
  if (borrowMint.equals(NATIVE_MINT) && !params.keepWsolAta) {
    ixs.push(
      createCloseAccountInstruction(userAta, owner, owner, [], TOKEN_PROGRAM_ID)
    );
  }
  return ixs;
}

/**
 * Borrow `borrowMint` against existing collateral (isolated pair market).
 */
export async function sendOmnipairBorrowTx(params: {
  connection: Connection;
  wallet: AnchorWallet;
  snapshot: OmnipairPoolSnapshot;
  borrowMint: PublicKey;
  amountRaw: bigint;
}): Promise<string> {
  const ixs = await buildBorrowIxs(params);
  return sendTx(params.connection, params.wallet, ixs, "borrow");
}

/**
 * Borrow flow matching Omnipair docs:
 * post project-token collateral → borrow SOL (up to ~65% of collateral value for safety).
 */
export async function sendOmnipairBorrowAgainstProjectTx(params: {
  connection: Connection;
  wallet: AnchorWallet;
  snapshot: OmnipairPoolSnapshot;
  /** Project token UI amount to post as collateral */
  collateralTokenUi: number;
  /** Optional override for SOL borrow UI; defaults to ~60% of collateral value */
  borrowSolUi?: number;
}): Promise<{
  /** Prefer 1 bundled signature (add collateral + borrow). */
  sigs: string[];
  collateralSig: string;
  borrowSig: string;
}> {
  const { connection, wallet, snapshot, collateralTokenUi } = params;
  const dec = snapshot.projectTokenDecimals;
  const collRaw = BigInt(Math.floor(collateralTokenUi * 10 ** dec));
  if (collRaw <= BigInt(0)) throw new Error("Enter collateral amount");

  const spot = snapshot.spotPriceSol;
  if (!(spot > 0)) throw new Error("Pool spot unavailable");

  const collValueSol = collateralTokenUi * spot;
  // Thin-pool impact-aware CF is often ≪ 22%; start conservative and back off.
  const borrowSolUi =
    params.borrowSolUi != null && params.borrowSolUi > 0
      ? params.borrowSolUi
      : collValueSol * 0.12;
  let borrowRaw = BigInt(Math.floor(borrowSolUi * 1e9));
  if (borrowRaw <= BigInt(0)) throw new Error("Borrow amount too small");

  const isBorrowPowerErr = (e: unknown) => {
    const msg = e instanceof Error ? e.message : String(e);
    return (
      msg.includes("BorrowingPowerExceeded") ||
      msg.includes("0x177a") ||
      msg.includes("6010") ||
      msg.includes("DebtMathOverflow") ||
      msg.includes("0x179c") ||
      msg.includes("6044")
    );
  };

  const existing = await fetchOmnipairUserPosition({
    connection,
    wallet,
    snapshot,
  });
  const projectIs0 = existing
    ? existing.token0.equals(snapshot.projectMint)
    : false;
  const existingProjectColl = existing
    ? projectIs0
      ? existing.collateral0
      : existing.collateral1
    : BigInt(0);

  let needAdd =
    existingProjectColl < collRaw
      ? existingProjectColl > BigInt(0)
        ? collRaw - existingProjectColl
        : collRaw
      : BigInt(0);

  let lastErr: unknown;
  for (let attempt = 0; attempt < 8; attempt++) {
    if (borrowRaw <= BigInt(0)) break;
    try {
      const ixs: TransactionInstruction[] = [];
      if (needAdd > BigInt(0)) {
        ixs.push(
          ...(await buildAddCollateralIxs({
            connection,
            wallet,
            snapshot,
            collateralMint: snapshot.projectMint,
            amountRaw: needAdd,
          }))
        );
      }
      ixs.push(
        ...(await buildBorrowIxs({
          connection,
          wallet,
          snapshot,
          borrowMint: NATIVE_MINT,
          amountRaw: borrowRaw,
        }))
      );
      const sig = await sendTx(
        connection,
        wallet,
        ixs,
        needAdd > BigInt(0) ? "borrow_open_1sig" : "borrow_1sig"
      );
      return { sigs: [sig], collateralSig: sig, borrowSig: sig };
    } catch (e) {
      lastErr = e;
      if (!isBorrowPowerErr(e)) throw e;
      borrowRaw = (borrowRaw * BigInt(50)) / BigInt(100);
      console.warn(
        `[omnipair:borrow] borrow backoff — retry @ attempt ${attempt + 1}`
      );
      // After a failed bundle, collateral may already be posted — don't double-add.
      const mid = await fetchOmnipairUserPosition({
        connection,
        wallet,
        snapshot,
      });
      const have = mid
        ? mid.token0.equals(snapshot.projectMint)
          ? mid.collateral0
          : mid.collateral1
        : BigInt(0);
      needAdd = have >= collRaw ? BigInt(0) : collRaw - have;
    }
  }
  throw lastErr instanceof Error
    ? lastErr
    : new Error("BorrowingPowerExceeded after backoff");
}

/**
 * One-step recursive leverage (docs):
 * Long project: collateral project → borrow SOL → swap SOL → project.
 * Short project: collateral SOL → borrow project → swap project → SOL.
 */
export async function sendOmnipairLeverageStepTx(params: {
  connection: Connection;
  wallet: AnchorWallet;
  snapshot: OmnipairPoolSnapshot;
  direction: "long" | "short";
  /** Long: project token UI as collateral. Short: SOL UI as collateral. */
  marginUi: number;
  leverage: number;
  slippagePercent?: number;
}): Promise<{ sigs: string[] }> {
  const {
    connection,
    wallet,
    snapshot,
    direction,
    marginUi,
    leverage,
    slippagePercent = 3,
  } = params;
  if (!(marginUi > 0)) throw new Error("Enter margin");
  const reserveSol = Number(snapshot.reserveSolRaw) / 1e9;
  const lev = clampLeverage(leverage, 5);
  const spot = snapshot.spotPriceSol;
  if (!(spot > 0)) throw new Error("Pool spot unavailable");

  // Docs (impact-aware CF): borrow limit = coll × CF × 0.95.
  // Bundle collateral → borrow → swap into **one wallet signature** (Omnipair sequential ixs).
  const borrowFraction = Math.max(0, lev - 1) / lev;
  const safeCf = poolSafeCf(reserveSol);

  const isBorrowPowerErr = (e: unknown) => {
    const msg = e instanceof Error ? e.message : String(e);
    return (
      msg.includes("BorrowingPowerExceeded") ||
      msg.includes("0x177a") ||
      msg.includes("6010") ||
      msg.includes("DebtMathOverflow") ||
      msg.includes("0x179c") ||
      msg.includes("6044")
    );
  };

  if (direction === "long") {
    const dec = snapshot.projectTokenDecimals;
    let collRaw = BigInt(Math.floor(marginUi * 10 ** dec));
    const collValueSol = marginUi * spot;
    // Conservative start — no mid-tx backoff when bundling.
    let borrowSol =
      collValueSol * Math.min(borrowFraction, safeCf) * 0.75;
    let lastErr: unknown;
    for (let attempt = 0; attempt < 6; attempt++) {
      // Skip re-adding collateral if a prior attempt already posted it.
      const mid = await fetchOmnipairUserPosition({
        connection,
        wallet,
        snapshot,
      });
      const haveColl = mid
        ? mid.token0.equals(snapshot.projectMint)
          ? mid.collateral0
          : mid.collateral1
        : BigInt(0);
      const addRaw =
        haveColl >= collRaw ? BigInt(0) : collRaw - haveColl;

      if (!(borrowSol > 0.000_001) && lev <= 1.05) {
        if (addRaw <= BigInt(0)) return { sigs: [] };
        const ixs = await buildAddCollateralIxs({
          connection,
          wallet,
          snapshot,
          collateralMint: snapshot.projectMint,
          amountRaw: addRaw,
        });
        const sig = await sendTx(connection, wallet, ixs, "leverage_long_1x");
        return { sigs: [sig] };
      }
      if (!(borrowSol > 0.000_001)) break;
      const borrowRaw = BigInt(Math.floor(borrowSol * 1e9));
      try {
        const ixs: TransactionInstruction[] = [];
        if (addRaw > BigInt(0)) {
          ixs.push(
            ...(await buildAddCollateralIxs({
              connection,
              wallet,
              snapshot,
              collateralMint: snapshot.projectMint,
              amountRaw: addRaw,
            }))
          );
        }
        ixs.push(
          ...(await buildBorrowIxs({
            connection,
            wallet,
            snapshot,
            borrowMint: NATIVE_MINT,
            amountRaw: borrowRaw,
            keepWsolAta: true,
          }))
        );
        // Spend borrowed WSOL → project in same tx (no unwrap).
        const swap = await buildOmnipairSwapIxs({
          connection,
          wallet,
          snapshot,
          side: "buy",
          amountUi: Number(borrowRaw) / 1e9,
          slippagePercent,
        });
        ixs.push(...swap.ixs);
        const sig = await sendTx(
          connection,
          wallet,
          ixs,
          "leverage_long_1sig",
          { extraSigners: swap.signers, computeUnits: 1_400_000 }
        );
        return { sigs: [sig] };
      } catch (e) {
        lastErr = e;
        const msg = e instanceof Error ? e.message : String(e);
        if (
          !isBorrowPowerErr(e) &&
          !/0x1781|6017|SlippageExceeded/i.test(msg)
        ) {
          throw e;
        }
        borrowSol *= 0.5;
        console.warn(
          `[omnipair:leverage] long bundle backoff @ ${borrowSol.toPrecision(3)} SOL borrow`
        );
      }
    }
    throw lastErr instanceof Error
      ? lastErr
      : new Error("Long leverage failed after backoff");
  }

  // Short: SOL collateral → borrow project → sell project (1 sig).
  const collRawTarget = BigInt(Math.floor(marginUi * 1e9));
  const shortCf = Math.min(safeCf, 0.14);
  let borrowSolValue =
    marginUi * Math.min(borrowFraction, shortCf) * 0.55;
  let lastErr: unknown;
  for (let attempt = 0; attempt < 6; attempt++) {
    const mid = await fetchOmnipairUserPosition({
      connection,
      wallet,
      snapshot,
    });
    const haveSolColl = mid
      ? NATIVE_MINT.equals(mid.token0)
        ? mid.collateral0
        : mid.collateral1
      : BigInt(0);
    const addRaw =
      haveSolColl >= collRawTarget ? BigInt(0) : collRawTarget - haveSolColl;

    const borrowTokenUi = borrowSolValue / spot;
    if (!(borrowTokenUi > 0)) break;
    const borrowRaw = BigInt(
      Math.floor(borrowTokenUi * 10 ** snapshot.projectTokenDecimals)
    );
    const sellUi =
      (Number(borrowRaw) / 10 ** snapshot.projectTokenDecimals) * 0.85;
    const shortSlip = Math.max(slippagePercent, 20) + attempt * 5;
    try {
      const ixs: TransactionInstruction[] = [];
      if (addRaw > BigInt(0)) {
        ixs.push(
          ...(await buildAddCollateralIxs({
            connection,
            wallet,
            snapshot,
            collateralMint: NATIVE_MINT,
            amountRaw: addRaw,
          }))
        );
      }
      ixs.push(
        ...(await buildBorrowIxs({
          connection,
          wallet,
          snapshot,
          borrowMint: snapshot.projectMint,
          amountRaw: borrowRaw,
        }))
      );
      const swap = await buildOmnipairSwapIxs({
        connection,
        wallet,
        snapshot,
        side: "sell",
        amountUi: sellUi,
        slippagePercent: shortSlip,
      });
      ixs.push(...swap.ixs);
      const sig = await sendTx(
        connection,
        wallet,
        ixs,
        "leverage_short_1sig",
        { extraSigners: swap.signers, computeUnits: 1_400_000 }
      );
      return { sigs: [sig] };
    } catch (e) {
      lastErr = e;
      const msg = e instanceof Error ? e.message : String(e);
      if (
        !isBorrowPowerErr(e) &&
        !/0x1781|6017|SlippageExceeded/i.test(msg)
      ) {
        throw e;
      }
      borrowSolValue *= 0.5;
      console.warn(
        `[omnipair:leverage] short bundle backoff @ attempt ${attempt + 1}`
      );
    }
  }
  throw lastErr instanceof Error
    ? lastErr
    : new Error("Short leverage failed after backoff");
}

const U64_MAX = new BN("18446744073709551615");

export type OmnipairUserPositionView = {
  position: PublicKey;
  collateral0: bigint;
  collateral1: bigint;
  debt0Shares: bigint;
  debt1Shares: bigint;
  debt0Raw: bigint;
  debt1Raw: bigint;
  /** Locked liquidation CF for collateral0 (bps). */
  collateral0LiquidationCfBps: number;
  /** Locked liquidation CF for collateral1 (bps). */
  collateral1LiquidationCfBps: number;
  token0: PublicKey;
  token1: PublicKey;
};

function sharesToDebt(shares: BN, totalDebt: BN, totalShares: BN): bigint {
  if (shares.isZero() || totalShares.isZero()) return BigInt(0);
  return BigInt(shares.mul(totalDebt).div(totalShares).toString());
}

/** Read on-chain user position + debt amounts (from pair share math). */
export async function fetchOmnipairUserPosition(params: {
  connection: Connection;
  wallet: AnchorWallet;
  snapshot: OmnipairPoolSnapshot;
  owner?: PublicKey;
}): Promise<OmnipairUserPositionView | null> {
  const { connection, wallet, snapshot } = params;
  const owner = params.owner ?? wallet.publicKey;
  if (!owner) return null;
  const pairPk = snapshot.pair;
  const [position] = deriveOmnipairUserPosition(pairPk, owner);
  const info = await connection.getAccountInfo(position, "confirmed");
  if (!info) return null;

  const program = getProgram(connection, wallet);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pos = await (program.account as any).userPosition.fetch(position);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pair = await (program.account as any).pair.fetch(pairPk);

  const debt0Shares = BigInt((pos.debt0Shares as BN).toString());
  const debt1Shares = BigInt((pos.debt1Shares as BN).toString());
  return {
    position,
    collateral0: BigInt((pos.collateral0 as BN).toString()),
    collateral1: BigInt((pos.collateral1 as BN).toString()),
    debt0Shares,
    debt1Shares,
    debt0Raw: sharesToDebt(
      pos.debt0Shares as BN,
      pair.totalDebt0 as BN,
      pair.totalDebt0Shares as BN
    ),
    debt1Raw: sharesToDebt(
      pos.debt1Shares as BN,
      pair.totalDebt1 as BN,
      pair.totalDebt1Shares as BN
    ),
    collateral0LiquidationCfBps: Number(
      pos.collateral0LiquidationCfBps ?? pos.collateral0_liquidation_cf_bps ?? 0
    ),
    collateral1LiquidationCfBps: Number(
      pos.collateral1LiquidationCfBps ?? pos.collateral1_liquidation_cf_bps ?? 0
    ),
    token0: pair.token0 as PublicKey,
    token1: pair.token1 as PublicKey,
  };
}

async function buildRepayIxs(params: {
  connection: Connection;
  wallet: AnchorWallet;
  snapshot: OmnipairPoolSnapshot;
  repayMint: PublicKey;
  amountRaw?: bigint;
  repayAll?: boolean;
  /** Optional pre-fetched position (avoids extra RPC when bundling). */
  pos?: OmnipairUserPositionView | null;
}): Promise<TransactionInstruction[]> {
  const { connection, wallet, snapshot, repayMint } = params;
  const owner = wallet.publicKey;
  if (!owner) throw new Error("Wallet not connected");
  const amountBn = params.repayAll
    ? U64_MAX
    : new BN((params.amountRaw ?? BigInt(0)).toString());
  if (!params.repayAll && amountBn.lten(0)) throw new Error("Repay amount too small");

  const pairPk = snapshot.pair;
  const program = getProgram(connection, wallet);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pairAcct = await (program.account as any).pair.fetch(pairPk);
  const rateModel = pairAcct.rateModel as PublicKey;
  const [userPosition] = deriveOmnipairUserPosition(pairPk, owner);
  const [reserveVault] = deriveOmnipairReserveVault(pairPk, repayMint);
  const [futarchyAuthority] = deriveOmnipairFutarchyAuthority();
  const eventAuthority = omnipairEventAuthorityPda();
  const tokenProgram = await mintTokenProgram(connection, repayMint);
  const userAta = getAssociatedTokenAddressSync(
    repayMint,
    owner,
    false,
    tokenProgram
  );

  const ixs: TransactionInstruction[] = [
    createAssociatedTokenAccountIdempotentInstruction(
      owner,
      userAta,
      owner,
      repayMint,
      tokenProgram,
      ASSOCIATED_TOKEN_PROGRAM_ID
    ),
  ];

  // Ensure WSOL ATA has enough for repay-all (program checks ATA balance).
  if (repayMint.equals(NATIVE_MINT)) {
    const pos =
      params.pos !== undefined
        ? params.pos
        : await fetchOmnipairUserPosition({ connection, wallet, snapshot });
    let need = params.repayAll
      ? pos
        ? repayMint.equals(pos.token0)
          ? pos.debt0Raw
          : pos.debt1Raw
        : BigInt(0)
      : (params.amountRaw ?? BigInt(0));
    // Small buffer for interest between fetch and execution.
    need = (need * BigInt(1005)) / BigInt(1000) + BigInt(1000);
    const bal = await connection.getTokenAccountBalance(userAta).catch(() => null);
    const have = BigInt(bal?.value.amount ?? "0");
    if (have < need) {
      const topUp = need - have;
      ixs.push(
        SystemProgram.transfer({
          fromPubkey: owner,
          toPubkey: userAta,
          lamports: Number(topUp),
        }),
        createSyncNativeInstruction(userAta)
      );
    }
  }

  const ix = await program.methods
    .repay({ amount: amountBn })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .accounts({
      pair: pairPk,
      userPosition,
      rateModel,
      futarchyAuthority,
      reserveVault,
      userReserveTokenAccount: userAta,
      reserveTokenMint: repayMint,
      user: owner,
      tokenProgram: TOKEN_PROGRAM_ID,
      token2022Program: TOKEN_2022_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
      eventAuthority,
      program: OMNIPAIR_PROGRAM_ID,
    } as any)
    .instruction();
  ixs.push(ix);

  if (repayMint.equals(NATIVE_MINT)) {
    ixs.push(
      createCloseAccountInstruction(userAta, owner, owner, [], TOKEN_PROGRAM_ID)
    );
  }
  return ixs;
}

async function buildRemoveCollateralIxs(params: {
  connection: Connection;
  wallet: AnchorWallet;
  snapshot: OmnipairPoolSnapshot;
  collateralMint: PublicKey;
  amountRaw?: bigint;
  removeAll?: boolean;
}): Promise<TransactionInstruction[]> {
  const { connection, wallet, snapshot, collateralMint } = params;
  const owner = wallet.publicKey;
  if (!owner) throw new Error("Wallet not connected");
  const amountBn = params.removeAll
    ? U64_MAX
    : new BN((params.amountRaw ?? BigInt(0)).toString());
  if (!params.removeAll && amountBn.lten(0)) {
    throw new Error("Withdraw amount too small");
  }

  const pairPk = snapshot.pair;
  const program = getProgram(connection, wallet);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pairAcct = await (program.account as any).pair.fetch(pairPk);
  const rateModel = pairAcct.rateModel as PublicKey;
  const [userPosition] = deriveOmnipairUserPosition(pairPk, owner);
  const [collateralVault] = deriveOmnipairCollateralVault(pairPk, collateralMint);
  const [futarchyAuthority] = deriveOmnipairFutarchyAuthority();
  const eventAuthority = omnipairEventAuthorityPda();
  const tokenProgram = await mintTokenProgram(connection, collateralMint);
  const userAta = getAssociatedTokenAddressSync(
    collateralMint,
    owner,
    false,
    tokenProgram
  );

  const ixs: TransactionInstruction[] = [
    createAssociatedTokenAccountIdempotentInstruction(
      owner,
      userAta,
      owner,
      collateralMint,
      tokenProgram,
      ASSOCIATED_TOKEN_PROGRAM_ID
    ),
  ];

  const ix = await program.methods
    .removeCollateral({ amount: amountBn })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .accounts({
      pair: pairPk,
      userPosition,
      rateModel,
      futarchyAuthority,
      collateralVault,
      userCollateralTokenAccount: userAta,
      collateralTokenMint: collateralMint,
      user: owner,
      tokenProgram: TOKEN_PROGRAM_ID,
      token2022Program: TOKEN_2022_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
      eventAuthority,
      program: OMNIPAIR_PROGRAM_ID,
    } as any)
    .instruction();
  ixs.push(ix);

  if (collateralMint.equals(NATIVE_MINT)) {
    ixs.push(
      createCloseAccountInstruction(userAta, owner, owner, [], TOKEN_PROGRAM_ID)
    );
  }
  return ixs;
}

/**
 * Repay borrowed tokens. Pass `amountRaw = u64::MAX` (via repayAll) to clear the side.
 */
export async function sendOmnipairRepayTx(params: {
  connection: Connection;
  wallet: AnchorWallet;
  snapshot: OmnipairPoolSnapshot;
  repayMint: PublicKey;
  /** Raw token amount; omit / use repayAll for full repay */
  amountRaw?: bigint;
  repayAll?: boolean;
}): Promise<string> {
  const ixs = await buildRepayIxs(params);
  return sendTx(params.connection, params.wallet, ixs, "repay");
}

/** Withdraw collateral. `u64::MAX` only when debt is fully repaid. */
export async function sendOmnipairRemoveCollateralTx(params: {
  connection: Connection;
  wallet: AnchorWallet;
  snapshot: OmnipairPoolSnapshot;
  collateralMint: PublicKey;
  amountRaw?: bigint;
  removeAll?: boolean;
}): Promise<string> {
  const ixs = await buildRemoveCollateralIxs(params);
  return sendTx(params.connection, params.wallet, ixs, "remove_collateral");
}

export type ClosePositionResult = {
  /** On-chain signatures that required a wallet signature (ideally 1). */
  sigs: string[];
  /** True when the position PDA exists but has zero debt+collateral (stale UI). */
  alreadyClosed?: boolean;
};

/**
 * Close position: optional cover-swap, then **one** bundled repay + withdraw tx.
 * Long / borrow (project coll, SOL debt): sell tokens if needed → repay SOL + remove project coll.
 * Short (SOL coll, project debt): buy tokens if needed → repay project + remove SOL coll.
 *
 * Returns `alreadyClosed: true` (0 sigs) when there is nothing on-chain to unwind —
 * callers must NOT treat that as a successful signed close.
 */
export async function sendOmnipairClosePositionTx(params: {
  connection: Connection;
  wallet: AnchorWallet;
  snapshot: OmnipairPoolSnapshot;
  /** Hint for which unwind path; inferred from on-chain debt if omitted */
  direction?: "long" | "short" | "borrow";
  slippagePercent?: number;
}): Promise<ClosePositionResult> {
  const {
    connection,
    wallet,
    snapshot,
    slippagePercent = 8,
  } = params;
  const owner = wallet.publicKey;
  if (!owner) throw new Error("Wallet not connected");

  const pos = await fetchOmnipairUserPosition({ connection, wallet, snapshot });
  if (!pos) {
    return { sigs: [], alreadyClosed: true };
  }

  const projectIs0 = pos.token0.equals(snapshot.projectMint);
  const debtSol = NATIVE_MINT.equals(pos.token0) ? pos.debt0Raw : pos.debt1Raw;
  const debtProject = projectIs0 ? pos.debt0Raw : pos.debt1Raw;
  const collSol = NATIVE_MINT.equals(pos.token0)
    ? pos.collateral0
    : pos.collateral1;
  const collProject = projectIs0 ? pos.collateral0 : pos.collateral1;
  const hasDebt = debtSol > BigInt(0) || debtProject > BigInt(0);
  const hasColl = collSol > BigInt(0) || collProject > BigInt(0);

  if (!hasDebt && !hasColl) {
    return { sigs: [], alreadyClosed: true };
  }

  // Infer direction from debt side when not provided.
  const direction =
    params.direction ??
    (debtProject > BigInt(0)
      ? "short"
      : debtSol > BigInt(0)
        ? "long"
        : collSol > BigInt(0)
          ? "short"
          : "long");

  // One signature: optional cover-swap + repay + withdraw (Omnipair sequential ixs).
  const closeIxs: TransactionInstruction[] = [];
  const extraSigners: Keypair[] = [];

  if (direction === "short" && debtProject > BigInt(0)) {
    const needUi =
      (Number(debtProject) / 10 ** snapshot.projectTokenDecimals) * 1.02;
    const tokenProgram = await mintTokenProgram(connection, snapshot.projectMint);
    const ata = getAssociatedTokenAddressSync(
      snapshot.projectMint,
      owner,
      false,
      tokenProgram
    );
    const bal = await connection.getTokenAccountBalance(ata).catch(() => null);
    const haveUi = Number(bal?.value.uiAmountString ?? "0");
    if (haveUi + 1e-12 < needUi) {
      const buySol =
        ((needUi - haveUi) * snapshot.spotPriceSol) / 0.85;
      const swap = await buildOmnipairSwapIxs({
        connection,
        wallet,
        snapshot,
        side: "buy",
        amountUi: Math.max(buySol, 0.001),
        slippagePercent: Math.max(slippagePercent, 12),
      });
      closeIxs.push(...swap.ixs);
      extraSigners.push(...swap.signers);
    }
  } else if (debtSol > BigInt(0)) {
    const needSol = (Number(debtSol) / 1e9) * 1.02;
    const solLamports = await connection.getBalance(owner, "confirmed");
    const haveSol = solLamports / 1e9;
    if (haveSol < needSol + 0.02) {
      const shortfall = needSol + 0.02 - haveSol;
      const sellUi =
        snapshot.spotPriceSol > 0
          ? (shortfall / snapshot.spotPriceSol) * 1.15
          : 0;
      if (sellUi > 0) {
        const tokenProgram = await mintTokenProgram(
          connection,
          snapshot.projectMint
        );
        const ata = getAssociatedTokenAddressSync(
          snapshot.projectMint,
          owner,
          false,
          tokenProgram
        );
        const bal = await connection.getTokenAccountBalance(ata).catch(() => null);
        const haveTok = Number(bal?.value.uiAmountString ?? "0");
        const attempt = Math.min(sellUi, haveTok * 0.95);
        if (attempt > 0) {
          const swap = await buildOmnipairSwapIxs({
            connection,
            wallet,
            snapshot,
            side: "sell",
            amountUi: attempt,
            slippagePercent: Math.max(slippagePercent, 20),
          });
          closeIxs.push(...swap.ixs);
          extraSigners.push(...swap.signers);
        }
      }
    }
  }

  if (debtProject > BigInt(0)) {
    closeIxs.push(
      ...(await buildRepayIxs({
        connection,
        wallet,
        snapshot,
        repayMint: snapshot.projectMint,
        repayAll: true,
        pos,
      }))
    );
  } else if (debtSol > BigInt(0)) {
    closeIxs.push(
      ...(await buildRepayIxs({
        connection,
        wallet,
        snapshot,
        repayMint: NATIVE_MINT,
        repayAll: true,
        pos,
      }))
    );
  }

  if (collProject > BigInt(0)) {
    closeIxs.push(
      ...(await buildRemoveCollateralIxs({
        connection,
        wallet,
        snapshot,
        collateralMint: snapshot.projectMint,
        removeAll: true,
      }))
    );
  }
  if (collSol > BigInt(0)) {
    closeIxs.push(
      ...(await buildRemoveCollateralIxs({
        connection,
        wallet,
        snapshot,
        collateralMint: NATIVE_MINT,
        removeAll: true,
      }))
    );
  }

  if (closeIxs.length === 0) {
    return { sigs: [], alreadyClosed: true };
  }

  const closeSig = await sendTx(
    connection,
    wallet,
    closeIxs,
    "close_position_1sig",
    { extraSigners, computeUnits: 1_400_000 }
  );
  const sigs = [closeSig];

  // Verify debt is gone; if not, surface clearly (do not pretend success).
  const after = await fetchOmnipairUserPosition({ connection, wallet, snapshot });
  if (
    after &&
    (after.debt0Raw > BigInt(0) || after.debt1Raw > BigInt(0))
  ) {
    throw new Error("Debt remains after close — repay may have failed");
  }

  return { sigs };
}

/**
 * Liquidate an undercollateralized UserPosition (Omnipair `liquidate`).
 * Anyone can call; payer receives seized collateral (minus protocol penalty share).
 * Pass the collateral mint that backs the unhealthy debt.
 */
export async function sendOmnipairLiquidateTx(params: {
  connection: Connection;
  wallet: AnchorWallet;
  snapshot: OmnipairPoolSnapshot;
  /** Owner of the underwater position */
  positionOwner: PublicKey;
  /** Collateral side to seize (project mint for borrows/longs; SOL for shorts) */
  collateralMint: PublicKey;
}): Promise<{ signature: string }> {
  const { connection, wallet, snapshot, positionOwner, collateralMint } =
    params;
  const payer = wallet.publicKey;
  if (!payer) throw new Error("Wallet not connected");

  const pairPk = snapshot.pair;
  const program = getProgram(connection, wallet);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pairAcct = await (program.account as any).pair.fetch(pairPk);
  const rateModel = pairAcct.rateModel as PublicKey;
  const [userPosition] = deriveOmnipairUserPosition(pairPk, positionOwner);
  const [collateralVault] = deriveOmnipairCollateralVault(
    pairPk,
    collateralMint
  );
  const [reserveVault] = deriveOmnipairReserveVault(pairPk, collateralMint);
  const [futarchyAuthority] = deriveOmnipairFutarchyAuthority();
  const eventAuthority = omnipairEventAuthorityPda();
  const tokenProgram = await mintTokenProgram(connection, collateralMint);
  const callerAta = getAssociatedTokenAddressSync(
    collateralMint,
    payer,
    false,
    tokenProgram
  );

  const ixs = [
    createAssociatedTokenAccountIdempotentInstruction(
      payer,
      callerAta,
      payer,
      collateralMint,
      tokenProgram,
      ASSOCIATED_TOKEN_PROGRAM_ID
    ),
  ];

  const ix = await program.methods
    .liquidate()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .accounts({
      pair: pairPk,
      userPosition,
      rateModel,
      futarchyAuthority,
      collateralVault,
      callerTokenAccount: callerAta,
      collateralTokenMint: collateralMint,
      reserveVault,
      positionOwner,
      payer,
      tokenProgram: TOKEN_PROGRAM_ID,
      token2022Program: TOKEN_2022_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
      eventAuthority,
      program: OMNIPAIR_PROGRAM_ID,
    } as any)
    .instruction();

  ixs.push(ix);

  // Unwrap seized WSOL so liquidator receives native SOL.
  if (collateralMint.equals(NATIVE_MINT)) {
    ixs.push(
      createCloseAccountInstruction(callerAta, payer, payer, [], TOKEN_PROGRAM_ID)
    );
  }

  const signature = await sendTx(
    connection,
    wallet,
    ixs,
    `liquidate ${positionOwner.toBase58().slice(0, 8)}`
  );
  return { signature };
}

/**
 * Partial adjust: repay some debt and/or withdraw some collateral (explicit amounts).
 */
export async function sendOmnipairAdjustPositionTx(params: {
  connection: Connection;
  wallet: AnchorWallet;
  snapshot: OmnipairPoolSnapshot;
  repayMint?: PublicKey;
  repayAmountRaw?: bigint;
  repayAll?: boolean;
  removeCollateralMint?: PublicKey;
  removeAmountRaw?: bigint;
  removeAll?: boolean;
}): Promise<{ sigs: string[] }> {
  const { connection, wallet, snapshot } = params;
  const sigs: string[] = [];
  if (params.repayMint && (params.repayAll || (params.repayAmountRaw ?? BigInt(0)) > BigInt(0))) {
    sigs.push(
      await sendOmnipairRepayTx({
        connection,
        wallet,
        snapshot,
        repayMint: params.repayMint,
        amountRaw: params.repayAmountRaw,
        repayAll: params.repayAll,
      })
    );
  }
  if (
    params.removeCollateralMint &&
    (params.removeAll || (params.removeAmountRaw ?? BigInt(0)) > BigInt(0))
  ) {
    sigs.push(
      await sendOmnipairRemoveCollateralTx({
        connection,
        wallet,
        snapshot,
        collateralMint: params.removeCollateralMint,
        amountRaw: params.removeAmountRaw,
        removeAll: params.removeAll,
      })
    );
  }
  if (!sigs.length) throw new Error("Nothing to adjust");
  return { sigs };
}

