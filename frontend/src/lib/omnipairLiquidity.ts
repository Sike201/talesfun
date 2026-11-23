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
import type { OmnipairPoolSnapshot } from "./omnipairPoolState";

const CU_ADD_LIQ = 800_000;

function getProgram(connection: Connection, wallet: AnchorWallet): Program<Omnipair> {
  const idl = { ...OmnipairIdl, address: OMNIPAIR_PROGRAM_ID.toBase58() };
  return new Program(
    idl as Omnipair,
    new AnchorProvider(connection, wallet, { commitment: "confirmed" })
  );
}

export async function sendOmnipairAddLiquidityTx(params: {
  connection: Connection;
  wallet: AnchorWallet;
  snapshot: OmnipairPoolSnapshot;
  /** SOL (WSOL) side amount to deposit */
  solUi: number;
  slippagePercent: number;
}): Promise<string> {
  const duskProgramId = new PublicKey(
    process.env.NEXT_PUBLIC_DUSK_PROGRAM_ID ||
      "DuskWhswJYrzABDn8GqQD191X9RobRi5jhgGntXEdnKj"
  );
  const duskDeployed = await params.connection.getAccountInfo(
    duskProgramId,
    "confirmed"
  );
  if (duskDeployed?.executable) {
    const { sendDuskAddLiquidityTx } = await import("./duskMarket");
    return sendDuskAddLiquidityTx(params);
  }

  const { connection, wallet, snapshot, solUi } = params;
  const owner = wallet.publicKey;
  if (!owner) throw new Error("Wallet not connected");
  if (!(solUi > 0)) throw new Error("Enter a SOL amount");

  const slipBps = Math.min(5000, Math.max(1, Math.round(params.slippagePercent * 100)));
  const pairPk = snapshot.pair;
  const program = getProgram(connection, wallet);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pairAcct = await (program.account as any).pair.fetch(pairPk);
  const rateModel = pairAcct.rateModel as PublicKey;
  const lpMint = pairAcct.lpMint as PublicKey;
  const token0 = pairAcct.token0 as PublicKey;
  const token1 = pairAcct.token1 as PublicKey;

  const [reserve0Vault] = deriveOmnipairReserveVault(pairPk, token0);
  const [reserve1Vault] = deriveOmnipairReserveVault(pairPk, token1);
  const [futarchyAuthority] = deriveOmnipairFutarchyAuthority();
  const eventAuthority = omnipairEventAuthorityPda();

  const solIs0 = token0.equals(NATIVE_MINT);
  const rSol = BigInt(snapshot.reserveSolRaw);
  const rProj = BigInt(snapshot.reserveProjectRaw);
  const solLamports = BigInt(Math.floor(solUi * 1e9));
  if (solLamports <= BigInt(0)) throw new Error("SOL amount too small");

  const projRaw =
    rSol > BigInt(0) ? (rProj * solLamports) / rSol : BigInt(0);
  if (projRaw <= BigInt(0)) throw new Error("Could not quote token leg");

  const amount0In = solIs0 ? solLamports : projRaw;
  const amount1In = solIs0 ? projRaw : solLamports;

  const userToken0 = getAssociatedTokenAddressSync(token0, owner);
  const userToken1 = getAssociatedTokenAddressSync(token1, owner);
  const userLp = getAssociatedTokenAddressSync(lpMint, owner);

  const ixs = [ComputeBudgetProgram.setComputeUnitLimit({ units: CU_ADD_LIQ })];

  const wsolAta = getAssociatedTokenAddressSync(NATIVE_MINT, owner);
  if (!(await connection.getAccountInfo(wsolAta, "confirmed"))) {
    ixs.push(
      createAssociatedTokenAccountInstruction(
        owner,
        wsolAta,
        owner,
        NATIVE_MINT,
        TOKEN_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID
      )
    );
  }
  ixs.push(
    SystemProgram.transfer({
      fromPubkey: owner,
      toPubkey: wsolAta,
      lamports: Number(solLamports),
    }),
    createSyncNativeInstruction(wsolAta)
  );

  const projAta = getAssociatedTokenAddressSync(
    snapshot.projectMint,
    owner,
    false,
    TOKEN_PROGRAM_ID
  );
  if (!(await connection.getAccountInfo(projAta, "confirmed"))) {
    ixs.push(
      createAssociatedTokenAccountInstruction(
        owner,
        projAta,
        owner,
        snapshot.projectMint,
        TOKEN_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID
      )
    );
  }

  if (!(await connection.getAccountInfo(userLp, "confirmed"))) {
    ixs.push(
      createAssociatedTokenAccountInstruction(
        owner,
        userLp,
        owner,
        lpMint,
        TOKEN_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID
      )
    );
  }

  const estLpOut = solLamports / BigInt(1000);
  const minLpOut = (estLpOut * BigInt(10_000 - slipBps)) / BigInt(10_000);

  const addIx = await program.methods
    .addLiquidity({
      amount0In: new BN(amount0In.toString()),
      amount1In: new BN(amount1In.toString()),
      minLiquidityOut: new BN(minLpOut > BigInt(0) ? minLpOut.toString() : "1"),
    })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .accounts({
      pair: pairPk,
      rateModel,
      futarchyAuthority,
      reserve0Vault,
      reserve1Vault,
      userToken0Account: userToken0,
      userToken1Account: userToken1,
      token0Mint: token0,
      token1Mint: token1,
      lpMint,
      userLpTokenAccount: userLp,
      user: owner,
      tokenProgram: TOKEN_PROGRAM_ID,
      token2022Program: TOKEN_2022_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
      eventAuthority,
      program: OMNIPAIR_PROGRAM_ID,
    } as any)
    .instruction();

  ixs.push(addIx);

  const { blockhash } = await connection.getLatestBlockhash("confirmed");
  const tx = new Transaction({ feePayer: owner, recentBlockhash: blockhash }).add(
    ...ixs
  );
  const signed = await wallet.signTransaction(tx);
  const sig = await connection.sendRawTransaction(signed.serialize(), {
    skipPreflight: false,
  });
  await connection.confirmTransaction(sig, "confirmed");
  return sig;
}
