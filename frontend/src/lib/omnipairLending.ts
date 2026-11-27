/**
 * Omnipair V1 lending: add/remove collateral, borrow/repay.
 * Matches docs.omnipair.fi borrowing + recursive leverage (collateral → borrow → swap).
 */
import { Program, AnchorProvider, BN } from "@coral-xyz/anchor";
import {
  ComputeBudgetProgram,
  Connection,
  PublicKey,
  SystemProgram,
  Transaction,
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
import { sendOmnipairSwapTx } from "./omnipairSwap";
import { clampLeverage, poolSafeCf } from "./poolMaxLeverage";

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
  label: string
): Promise<string> {
  const tx = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: CU }),
    ...ixs
  );
  tx.feePayer = wallet.publicKey;
  const { blockhash, lastValidBlockHeight } =
    await connection.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
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

  const ixs = [];
  if (collateralMint.equals(NATIVE_MINT)) {
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
  } else if (!(await connection.getAccountInfo(userAta, "confirmed"))) {
    throw new Error("No token balance to post as collateral");
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
  return sendTx(connection, wallet, ixs, "add_collateral");
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

  const ixs = [
    createAssociatedTokenAccountIdempotentInstruction(
      owner,
      userAta,
      owner,
      borrowMint,
      tokenProgram,
      ASSOCIATED_TOKEN_PROGRAM_ID
    ),
  ];

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

  // If borrowing WSOL, unwrap to native SOL for wallet UX.
  if (borrowMint.equals(NATIVE_MINT)) {
    ixs.push(
      createCloseAccountInstruction(userAta, owner, owner, [], TOKEN_PROGRAM_ID)
    );
  }

  return sendTx(connection, wallet, ixs, "borrow");
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
}): Promise<{ collateralSig: string; borrowSig: string }> {
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

  const collateralSig = await sendOmnipairAddCollateralTx({
    connection,
    wallet,
    snapshot,
    collateralMint: snapshot.projectMint,
    amountRaw: collRaw,
  });

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

  let borrowSig = "";
  let lastErr: unknown;
  for (let attempt = 0; attempt < 8; attempt++) {
    if (borrowRaw <= BigInt(0)) break;
    try {
      borrowSig = await sendOmnipairBorrowTx({
        connection,
        wallet,
        snapshot,
        borrowMint: NATIVE_MINT,
        amountRaw: borrowRaw,
      });
      lastErr = undefined;
      break;
    } catch (e) {
      lastErr = e;
      if (!isBorrowPowerErr(e)) throw e;
      borrowRaw = (borrowRaw * BigInt(50)) / BigInt(100);
      console.warn(
        `[omnipair:borrow] borrow backoff — retry @ attempt ${attempt + 1}`
      );
    }
  }
  if (!borrowSig) {
    throw lastErr instanceof Error
      ? lastErr
      : new Error("BorrowingPowerExceeded after backoff");
  }

  return { collateralSig, borrowSig };
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

  const sigs: string[] = [];
  // Docs (impact-aware CF): borrow limit = coll × CF × 0.95, CF often ≪ 85% on thin
  // pools because liquidation impact is simulated against AMM reserves.
  const borrowFraction = Math.max(0, lev - 1) / lev;
  // Depth-aware CF — same curve as the leverage slider Max.
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

  /** Step down borrow size until it clears impact-aware CF / debt math (thin-pool safe). */
  const borrowWithBackoff = async (
    borrowMint: PublicKey,
    initialRaw: bigint
  ): Promise<{ sig: string; usedRaw: bigint }> => {
    // Start smaller for project-token borrows (short path) — debt share math overflows on thin pools.
    let amount = borrowMint.equals(NATIVE_MINT)
      ? initialRaw
      : (initialRaw * BigInt(35)) / BigInt(100);
    let lastErr: unknown;
    for (let attempt = 0; attempt < 8; attempt++) {
      if (amount <= BigInt(0)) break;
      try {
        const sig = await sendOmnipairBorrowTx({
          connection,
          wallet,
          snapshot,
          borrowMint,
          amountRaw: amount,
        });
        return { sig, usedRaw: amount };
      } catch (e) {
        lastErr = e;
        if (!isBorrowPowerErr(e)) throw e;
        amount = (amount * BigInt(50)) / BigInt(100);
        console.warn(
          `[omnipair:leverage] borrow backoff — retry @ ${(Number(amount) / Number(initialRaw || BigInt(1)) * 100).toFixed(0)}%`
        );
      }
    }
    throw lastErr instanceof Error
      ? lastErr
      : new Error("Borrow failed after backoff");
  };

  if (direction === "long") {
    const dec = snapshot.projectTokenDecimals;
    const collRaw = BigInt(Math.floor(marginUi * 10 ** dec));
    sigs.push(
      await sendOmnipairAddCollateralTx({
        connection,
        wallet,
        snapshot,
        collateralMint: snapshot.projectMint,
        amountRaw: collRaw,
      })
    );
    const collValueSol = marginUi * spot;
    const borrowSol = collValueSol * Math.min(borrowFraction, safeCf) * 0.9;
    if (borrowSol > 0.000_001) {
      const borrowRaw = BigInt(Math.floor(borrowSol * 1e9));
      const { sig, usedRaw } = await borrowWithBackoff(NATIVE_MINT, borrowRaw);
      sigs.push(sig);
      const usedSol = Number(usedRaw) / 1e9;
      const swap = await sendOmnipairSwapTx({
        connection,
        wallet,
        snapshot,
        side: "buy",
        amountUi: usedSol,
        slippagePercent,
      });
      sigs.push(swap.signature);
    }
  } else {
    const collRaw = BigInt(Math.floor(marginUi * 1e9));
    sigs.push(
      await sendOmnipairAddCollateralTx({
        connection,
        wallet,
        snapshot,
        collateralMint: NATIVE_MINT,
        amountRaw: collRaw,
      })
    );
    // Shorts sell borrowed project tokens into the pool — keep borrow smaller than longs.
    const shortCf = Math.min(safeCf, 0.14);
    const borrowSolValue = marginUi * Math.min(borrowFraction, shortCf) * 0.85;
    const borrowTokenUi = borrowSolValue / spot;
    if (borrowTokenUi > 0) {
      const borrowRaw = BigInt(
        Math.floor(borrowTokenUi * 10 ** snapshot.projectTokenDecimals)
      );
      const { sig, usedRaw } = await borrowWithBackoff(
        snapshot.projectMint,
        borrowRaw
      );
      sigs.push(sig);
      const usedTokenUi =
        Number(usedRaw) / 10 ** snapshot.projectTokenDecimals;
      // Sell less than borrowed + wider slippage — thin pools blow past CPMM minOut.
      const sellUi = usedTokenUi * 0.85;
      const shortSlip = Math.max(slippagePercent, 20);
      let swapSig = "";
      let lastSwapErr: unknown;
      let attemptUi = sellUi;
      for (let attempt = 0; attempt < 5; attempt++) {
        if (!(attemptUi > 0)) break;
        try {
          const swap = await sendOmnipairSwapTx({
            connection,
            wallet,
            snapshot,
            side: "sell",
            amountUi: attemptUi,
            slippagePercent: shortSlip + attempt * 5,
          });
          swapSig = swap.signature;
          lastSwapErr = undefined;
          break;
        } catch (e) {
          lastSwapErr = e;
          const msg = e instanceof Error ? e.message : String(e);
          if (!/0x1781|6017|SlippageExceeded/i.test(msg)) throw e;
          attemptUi *= 0.55;
          console.warn(
            `[omnipair:leverage] short sell SlippageExceeded — retry @ ${(attemptUi / sellUi * 100).toFixed(0)}%`
          );
        }
      }
      if (!swapSig) {
        throw lastSwapErr instanceof Error
          ? lastSwapErr
          : new Error("Short unwind swap failed after backoff");
      }
      sigs.push(swapSig);
    }
  }

  return { sigs };
}
