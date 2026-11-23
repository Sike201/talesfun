/**
 * Omnipair V2 (Dusk) client.
 *
 * Graduation does not CPI the old GAMM. The launchpad releases reserves,
 * this module opens a Dusk market with the SDK, seeds it, then links the address.
 */
import { AnchorProvider, BN } from "@coral-xyz/anchor";
import {
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  createSyncNativeInstruction,
  createTransferCheckedWithTransferHookInstruction,
} from "@solana/spl-token";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  VersionedTransaction,
  type TransactionInstruction,
} from "@solana/web3.js";
import type { AnchorWallet } from "@solana/wallet-adapter-react";
import {
  Dusk,
  DUSK_PROGRAM_ID,
  createHookedLpMintInstructions,
  defaultMarketLaunchConfig,
  deriveMarketAddress,
  deriveMarketReserveVaultAddress,
  deriveYieldAccountAddress,
  lpMintRent,
  marketCreationLookupTablePlan,
  marketCreationV0Transaction,
} from "@omnipair/dusk-sdk";
import {
  getProgram,
  getReadOnlyProgram,
  getSolVaultPDA,
  getTokenStatePDA,
} from "./program";
import type { OmnipairPoolSnapshot } from "./omnipairPoolState";
import { OMNIPAIR_SWAP_FEE_BPS } from "@/types";

/**
 * Solana incinerator — dead address used to permanently lock srLP.
 * We transfer claimable bootstrap srLP here instead of calling Omnipair
 * remove_liquidity / withdraw, which would pull liquidity out of the market.
 */
export const SRLP_INCINERATOR = new PublicKey(
  "1nc1nerator11111111111111111111111111111111"
);

export const DUSK_PROGRAM_ID_STR =
  process.env.NEXT_PUBLIC_DUSK_PROGRAM_ID ||
  process.env.NEXT_PUBLIC_OMNIPAIR_PROGRAM_ID ||
  DUSK_PROGRAM_ID.toBase58();

const INDEXER =
  process.env.NEXT_PUBLIC_DUSK_INDEXER_URL ||
  "https://api.indexer.omnipair.fi/api/v1";

const TOKEN_DECIMALS = 6;

function duskFor(connection: Connection, wallet: AnchorWallet) {
  const provider = new AnchorProvider(connection, wallet, { commitment: "confirmed" });
  return new Dusk({
    provider,
    programId: new PublicKey(DUSK_PROGRAM_ID_STR),
    indexerBaseUrl: INDEXER,
  });
}

function readOnlyWallet(connection: Connection): AnchorWallet {
  return {
    publicKey: PublicKey.default,
    signTransaction: async <T,>(tx: T) => tx,
    signAllTransactions: async <T,>(txs: T[]) => txs,
  } as AnchorWallet;
}

async function sendLegacy(
  connection: Connection,
  wallet: AnchorWallet,
  instructions: TransactionInstruction[],
  extra: Keypair[] = []
): Promise<string> {
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  const tx = new Transaction({ feePayer: wallet.publicKey, blockhash, lastValidBlockHeight });
  tx.add(...instructions);
  for (const kp of extra) tx.partialSign(kp);
  const signed = await wallet.signTransaction(tx);
  const signature = await connection.sendRawTransaction(signed.serialize(), { maxRetries: 3 });
  await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, "confirmed");
  return signature;
}

async function sendVersioned(
  connection: Connection,
  wallet: AnchorWallet,
  tx: VersionedTransaction
): Promise<string> {
  const signed = await wallet.signTransaction(tx as unknown as Transaction);
  const raw = (signed as unknown as VersionedTransaction).serialize();
  const signature = await connection.sendRawTransaction(raw, { maxRetries: 3 });
  const latest = await connection.getLatestBlockhash("confirmed");
  await connection.confirmTransaction(
    { signature, blockhash: latest.blockhash, lastValidBlockHeight: latest.lastValidBlockHeight },
    "confirmed"
  );
  return signature;
}

function asPubkey(value: unknown): PublicKey {
  if (value instanceof PublicKey) return value;
  if (value && typeof value === "object" && "toBase58" in value) {
    return new PublicKey((value as { toBase58: () => string }).toBase58());
  }
  return new PublicKey(String(value));
}

function bn(value: { toString(): string } | bigint | number): bigint {
  return BigInt(value.toString());
}

/** Quote per base, in Dusk's 9-decimal NAD units, from the bonding curve's terminal reserves. */
function terminalPriceNad(virtualSol: bigint, virtualToken: bigint, baseDecimals: number): bigint {
  if (virtualToken <= BigInt(0)) throw new Error("Bonding curve has no token reserve");
  return (virtualSol * BigInt(10) ** BigInt(baseDecimals)) / virtualToken;
}

export async function fetchDuskPoolSnapshot(
  connection: Connection,
  marketAddress: string,
  projectMintAddress: string,
  walletPubkey: PublicKey | null
): Promise<{ ok: true; data: OmnipairPoolSnapshot } | { ok: false; message: string }> {
  let marketPk: PublicKey;
  let projectPk: PublicKey;
  try {
    marketPk = new PublicKey(marketAddress);
    projectPk = new PublicKey(projectMintAddress);
  } catch {
    return { ok: false, message: "Invalid market or mint address" };
  }

  try {
    const dusk = duskFor(connection, readOnlyWallet(connection));
    const market = await dusk.get.market(marketPk);
    const baseMint = asPubkey(market.baseSide.assetMint);
    const quoteMint = asPubkey(market.quoteSide.assetMint);
    const baseVault = asPubkey(market.baseSide.reserveVault);
    const quoteVault = asPubkey(market.quoteSide.reserveVault);
    const srlpMint = asPubkey(market.srlpMint);

    const projectIsBase = baseMint.equals(projectPk);
    const projectIsQuote = quoteMint.equals(projectPk);
    if (!projectIsBase && !projectIsQuote) {
      return { ok: false, message: "Market does not include this token" };
    }
    const solMint = projectIsBase ? quoteMint : baseMint;
    if (!solMint.equals(NATIVE_MINT)) {
      return { ok: false, message: "Market is not quoted in SOL" };
    }

    const [baseBal, quoteBal, lpSupply] = await Promise.all([
      connection.getTokenAccountBalance(baseVault, "confirmed"),
      connection.getTokenAccountBalance(quoteVault, "confirmed"),
      connection.getTokenSupply(srlpMint, "confirmed"),
    ]);

    const reserveProjectRaw = projectIsBase ? baseBal.value.amount : quoteBal.value.amount;
    const reserveSolRaw = projectIsBase ? quoteBal.value.amount : baseBal.value.amount;
    const projectDecimals = projectIsBase ? baseBal.value.decimals : quoteBal.value.decimals;
    const solUi = Number(reserveSolRaw) / 10 ** 9;
    const tokenUi = Number(reserveProjectRaw) / 10 ** projectDecimals;
    const spotPriceSol = tokenUi > 0 ? solUi / tokenUi : 0;

    let walletLpBalanceRaw = "0";
    if (walletPubkey) {
      const ata = getAssociatedTokenAddressSync(
        srlpMint,
        walletPubkey,
        false,
        TOKEN_2022_PROGRAM_ID
      );
      const bal = await connection.getTokenAccountBalance(ata, "confirmed").catch(() => null);
      walletLpBalanceRaw = bal?.value.amount ?? "0";
    }

    const token0 = baseMint;
    const token1 = quoteMint;
    return {
      ok: true,
      data: {
        pair: marketPk,
        token0,
        token1,
        lpMint: srlpMint,
        projectMint: projectPk,
        projectSide: projectIsBase ? 0 : 1,
        vaultProject: projectIsBase ? baseVault : quoteVault,
        vaultSol: projectIsBase ? quoteVault : baseVault,
        reserveProjectRaw,
        reserveSolRaw,
        projectTokenDecimals: projectDecimals,
        solDecimals: 9,
        pairReserve0: BigInt(baseBal.value.amount),
        pairReserve1: BigInt(quoteBal.value.amount),
        lpMintSupplyRaw: lpSupply.value.amount,
        lpDecimals: lpSupply.value.decimals,
        walletLpBalanceRaw,
        spotPriceSol,
        token0Decimals: baseBal.value.decimals,
        token1Decimals: quoteBal.value.decimals,
      },
    };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "Could not read the Dusk market",
    };
  }
}

export async function sendDuskSwapTx(params: {
  connection: Connection;
  wallet: AnchorWallet;
  snapshot: OmnipairPoolSnapshot;
  side: "buy" | "sell";
  amountUi: number;
  slippagePercent: number;
}): Promise<{
  signature: string;
  fill: { timestamp: string; sol_amount_raw: string; token_amount_raw: string; price_sol: number };
}> {
  const { connection, wallet, snapshot, side, amountUi, slippagePercent } = params;
  const owner = wallet.publicKey;
  if (!(amountUi > 0)) throw new Error("Enter a valid amount");
  const dusk = duskFor(connection, wallet);
  const projectMint = snapshot.projectMint;
  const assetIn = side === "buy" ? NATIVE_MINT : projectMint;
  const assetOut = side === "buy" ? projectMint : NATIVE_MINT;
  const amountIn =
    side === "buy"
      ? BigInt(Math.floor(amountUi * 1e9))
      : BigInt(Math.floor(amountUi * 10 ** snapshot.projectTokenDecimals));
  if (amountIn <= BigInt(0)) throw new Error("Amount too small");

  const quote = await dusk.get.previewSwap({
    market: snapshot.pair,
    assetInMint: assetIn,
    assetOutMint: assetOut,
    exactAssetIn: new BN(amountIn.toString()),
  });
  const netOut = bn(quote.netAmountOut);
  const slipBps = BigInt(Math.min(5000, Math.max(1, Math.round(slippagePercent * 100))));
  const minOut = (netOut * (BigInt(10000) - slipBps)) / BigInt(10000);
  if (minOut <= BigInt(0)) throw new Error("Quoted output is too small");

  const userWsol = getAssociatedTokenAddressSync(NATIVE_MINT, owner, false, TOKEN_PROGRAM_ID);
  const userToken = getAssociatedTokenAddressSync(projectMint, owner, false, TOKEN_PROGRAM_ID);
  const setup: TransactionInstruction[] = [];
  if (!(await connection.getAccountInfo(userWsol))) {
    setup.push(
      createAssociatedTokenAccountIdempotentInstruction(owner, userWsol, owner, NATIVE_MINT, TOKEN_PROGRAM_ID)
    );
  }
  if (!(await connection.getAccountInfo(userToken))) {
    setup.push(
      createAssociatedTokenAccountIdempotentInstruction(owner, userToken, owner, projectMint, TOKEN_PROGRAM_ID)
    );
  }
  if (side === "buy") {
    let existing = BigInt(0);
    try {
      existing = BigInt((await connection.getTokenAccountBalance(userWsol)).value.amount);
    } catch {
      existing = BigInt(0);
    }
    const need = amountIn > existing ? amountIn - existing : BigInt(0);
    if (need > BigInt(0)) {
      setup.push(
        SystemProgram.transfer({
          fromPubkey: owner,
          toPubkey: userWsol,
          lamports: Number(need),
        })
      );
    }
    setup.push(createSyncNativeInstruction(userWsol));
  }

  const swapTx = await dusk.write.buildSwapTransaction({
    market: snapshot.pair,
    trader: owner,
    assetInMint: assetIn,
    assetOutMint: assetOut,
    exactAssetIn: amountIn.toString(),
    minAssetOut: minOut.toString(),
  });
  const signature = await sendLegacy(connection, wallet, [...setup, ...swapTx.instructions]);

  const solRaw = side === "buy" ? amountIn : minOut;
  const tokenRaw = side === "buy" ? minOut : amountIn;
  const tokenUi = Number(tokenRaw) / 10 ** snapshot.projectTokenDecimals;
  const price = tokenUi > 0 ? Number(solRaw) / 1e9 / tokenUi : snapshot.spotPriceSol;
  return {
    signature,
    fill: {
      timestamp: new Date().toISOString(),
      sol_amount_raw: solRaw.toString(),
      token_amount_raw: tokenRaw.toString(),
      price_sol: price,
    },
  };
}

export async function sendDuskAddLiquidityTx(params: {
  connection: Connection;
  wallet: AnchorWallet;
  snapshot: OmnipairPoolSnapshot;
  solUi: number;
  slippagePercent: number;
}): Promise<string> {
  const { connection, wallet, snapshot, solUi, slippagePercent } = params;
  const owner = wallet.publicKey;
  if (!(solUi > 0)) throw new Error("Enter a SOL amount");
  const solRaw = BigInt(Math.floor(solUi * 1e9));
  const reservesSol = BigInt(snapshot.reserveSolRaw);
  const reservesToken = BigInt(snapshot.reserveProjectRaw);
  if (reservesSol <= BigInt(0)) throw new Error("Market has no SOL reserve yet");
  const tokenRaw = (reservesToken * solRaw) / reservesSol;
  const slipBps = BigInt(Math.min(5000, Math.max(1, Math.round(slippagePercent * 100))));
  const minSrlp = BigInt(1);
  void slipBps;

  const baseMint = snapshot.token0;
  const quoteMint = snapshot.token1;
  const baseRaw = baseMint.equals(NATIVE_MINT) ? solRaw : tokenRaw;
  const quoteRaw = quoteMint.equals(NATIVE_MINT) ? solRaw : tokenRaw;
  const dusk = duskFor(connection, wallet);
  const ownerBase = getAssociatedTokenAddressSync(baseMint, owner, false, TOKEN_PROGRAM_ID);
  const ownerQuote = getAssociatedTokenAddressSync(quoteMint, owner, false, TOKEN_PROGRAM_ID);
  const ownerSrlp = getAssociatedTokenAddressSync(
    snapshot.lpMint,
    owner,
    false,
    TOKEN_2022_PROGRAM_ID
  );
  const setup: TransactionInstruction[] = [];
  if (!(await connection.getAccountInfo(ownerSrlp))) {
    setup.push(
      createAssociatedTokenAccountIdempotentInstruction(
        owner,
        ownerSrlp,
        owner,
        snapshot.lpMint,
        TOKEN_2022_PROGRAM_ID
      )
    );
  }
  const tx = await dusk.write.addLiquidityTransaction({
    market: snapshot.pair,
    owner,
    baseMint,
    quoteMint,
    srlpMint: snapshot.lpMint,
    ownerBaseAccount: ownerBase,
    ownerQuoteAccount: ownerQuote,
    ownerSrlpAccount: ownerSrlp,
    baseDepositAmount: baseRaw.toString(),
    quoteDepositAmount: quoteRaw.toString(),
    minSrlpAmount: minSrlp.toString(),
  });
  return sendLegacy(connection, wallet, [...setup, ...tx.instructions]);
}

async function releaseReserves(
  connection: Connection,
  wallet: AnchorWallet,
  mint: PublicKey
): Promise<void> {
  const program = getProgram(wallet, connection);
  const [tokenState] = getTokenStatePDA(mint);
  const [solVault] = getSolVaultPDA(mint);
  const tokenVault = getAssociatedTokenAddressSync(mint, solVault, true, TOKEN_PROGRAM_ID);
  try {
    await (program.methods as any)
      .releaseGraduationReserves()
      .accounts({
        tokenState,
        mint,
        solVault,
        tokenVault,
        deployer: wallet.publicKey,
        wsolMint: NATIVE_MINT,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/InsufficientLiquidity|already been processed|GammPoolAlreadyLinked/i.test(message)) return;
    if (/Fallback functions are not supported|InstructionFallbackNotFound|invalid instruction/i.test(message)) {
      throw new Error(
        "The launchpad program on this cluster does not have release_graduation_reserves yet. Redeploy higher-launchpad, then open the market again."
      );
    }
    throw error;
  }
}

async function waitForLookupTable(connection: Connection, address: PublicKey) {
  for (let attempt = 0; attempt < 30; attempt++) {
    const table = await connection.getAddressLookupTable(address);
    if (table.value && table.value.state.addresses.length > 0) return table.value;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("Dusk market lookup table was not ready. Retry the launch.");
}

/**
 * Permanently lock claimable bootstrap srLP by transferring it to the incinerator.
 *
 * Why transfer instead of Omnipair remove_liquidity / withdraw?
 * - remove_liquidity would redeem srLP for the underlying reserves and drain the market.
 * - Transferring to a dead address keeps the reserves in the pool forever (standard AMM lock).
 * - Omnipair's own permanent junior seed is already protocol-locked; we only burn the
 *   claimable srLP the platform received for seeding.
 */
async function lockBootstrapSrlpAtIncinerator(params: {
  connection: Connection;
  wallet: AnchorWallet;
  srlpMint: PublicKey;
  ownerSrlp: PublicKey;
}): Promise<string | null> {
  const { connection, wallet, srlpMint, ownerSrlp } = params;
  const bal = await connection.getTokenAccountBalance(ownerSrlp, "confirmed").catch(() => null);
  const raw = bal?.value.amount ?? "0";
  if (raw === "0") {
    console.info("[dusk] no claimable srLP to lock");
    return null;
  }
  const amount = BigInt(raw);
  const decimals = bal?.value.decimals ?? 9;
  const incineratorAta = getAssociatedTokenAddressSync(
    srlpMint,
    SRLP_INCINERATOR,
    true,
    TOKEN_2022_PROGRAM_ID
  );

  const setup: TransactionInstruction[] = [];
  if (!(await connection.getAccountInfo(incineratorAta, "confirmed"))) {
    setup.push(
      createAssociatedTokenAccountIdempotentInstruction(
        wallet.publicKey,
        incineratorAta,
        SRLP_INCINERATOR,
        srlpMint,
        TOKEN_2022_PROGRAM_ID
      )
    );
  }

  // Token-2022 transfer-hook aware: resolves ExtraAccountMetaList for hooked srLP.
  const transferIx = await createTransferCheckedWithTransferHookInstruction(
    connection,
    ownerSrlp,
    srlpMint,
    incineratorAta,
    wallet.publicKey,
    amount,
    decimals,
    [],
    "confirmed",
    TOKEN_2022_PROGRAM_ID
  );

  const sig = await sendLegacy(connection, wallet, [...setup, transferIx]);
  console.info("[dusk] locked bootstrap srLP at incinerator", {
    srlpMint: srlpMint.toBase58(),
    amount: raw,
    incinerator: SRLP_INCINERATOR.toBase58(),
    signature: sig,
  });
  return sig;
}

/**
 * Release bonding-curve reserves, open a Dusk market (base = token, quote = SOL),
 * seed it, lock claimable srLP at the incinerator, and store the market on the launchpad.
 *
 * Operator: Dusk binds the initializeMarket `payer` as market operator. Bootstrap must
 * therefore be signed by the platform authority (keeper = NEXT_PUBLIC_PLATFORM_AUTHORITY)
 * so the platform — not a random creator wallet — is the operator.
 */
export async function graduateToDuskMarket(params: {
  connection: Connection;
  wallet: AnchorWallet;
  mint: PublicKey;
  ticker: string;
  lpUri: string;
}): Promise<string> {
  const { connection, wallet, mint, ticker, lpUri } = params;
  if (!lpUri.startsWith("http")) throw new Error("Token metadata URI must start with http");
  const owner = wallet.publicKey;
  const dusk = duskFor(connection, wallet);
  const programId = new PublicKey(DUSK_PROGRAM_ID_STR);

  const platformAuthority = process.env.NEXT_PUBLIC_PLATFORM_AUTHORITY?.trim();
  if (platformAuthority && owner.toBase58() !== platformAuthority) {
    console.warn(
      "[dusk] graduating wallet is not NEXT_PUBLIC_PLATFORM_AUTHORITY — " +
        "market operator will be the payer, not the platform",
      { payer: owner.toBase58(), platformAuthority }
    );
  }

  await releaseReserves(connection, wallet, mint);

  const read = getReadOnlyProgram(connection);
  const [tokenState] = getTokenStatePDA(mint);
  const state = await (read.account as any).tokenState.fetch(tokenState);
  const virtualSol = BigInt(state.virtualSolReserve.toString());
  const virtualToken = BigInt(state.virtualTokenReserve.toString());
  const priceNad = terminalPriceNad(virtualSol, virtualToken, TOKEN_DECIMALS);
  // Base swap fee 30 bps (0.30%) on the graduated Omnipair / Dusk market.
  const config = defaultMarketLaunchConfig({ swapFeeBps: OMNIPAIR_SWAP_FEE_BPS });
  const paramsHash = await dusk.write.marketParamsHashFor({
    payer: owner,
    config,
    operatorInterestShareBps: 0,
    oracle: null,
    bootstrapPriceNad: priceNad.toString(),
    launchFeeProgressOffset: 0,
  });
  const [market] = deriveMarketAddress(mint, NATIVE_MINT, paramsHash, programId);

  const existing = await connection.getAccountInfo(market, "confirmed");
  let lastSig = "";
  if (!existing) {
    const futarchy = await dusk.get.futarchyAuthority();
    const teamTreasury = asPubkey(
      (futarchy.recipients as { teamTreasury: unknown }).teamTreasury
    );
    const teamWsol = getAssociatedTokenAddressSync(NATIVE_MINT, teamTreasury, true);
    const rent = await lpMintRent(connection);
    const hooked = (["srlp", "baseHlp", "quoteHlp"] as const).map(() =>
      createHookedLpMintInstructions({
        payer: owner,
        decimals: 9,
        mintAuthority: market,
        transferHookProgramId: programId,
        lamports: rent,
      })
    );
    lastSig = await sendLegacy(
      connection,
      wallet,
      hooked.flatMap((mintIx) => [...mintIx.instructions]),
      hooked.map((mintIx) => mintIx.keypair)
    );

    const symbol = ticker.replace(/[^A-Za-z0-9]/g, "").slice(0, 8) || "TOKEN";
    const meta = (suffix: string, sym: string) => ({
      name: `${symbol} ${suffix}`.slice(0, 32),
      symbol: sym.slice(0, 10),
      uri: lpUri,
    });
    const initIx = await dusk.write.initializeMarketInstruction({
      payer: owner,
      baseMint: mint,
      quoteMint: NATIVE_MINT,
      srlpMint: hooked[0]!.mint,
      baseHlpMint: hooked[1]!.mint,
      quoteHlpMint: hooked[2]!.mint,
      teamTreasury,
      teamTreasuryWsolAccount: teamWsol,
      paramsHash,
      config,
      operatorInterestShareBps: 0,
      oracle: null,
      bootstrapPriceNad: priceNad.toString(),
      launchFeeProgressOffset: 0,
      lpMetadata: {
        srlp: meta("srLP", `${symbol}S`),
        baseHlp: meta("base hLP", `${symbol}B`),
        quoteHlp: meta("quote hLP", `${symbol}Q`),
      },
    });
    const slot = await connection.getSlot("confirmed");
    const plan = marketCreationLookupTablePlan({
      payer: owner,
      recentSlot: slot,
      initializeMarketInstruction: initIx,
    });
    await sendLegacy(connection, wallet, [plan.createInstruction, ...plan.extendInstructions]);
    const lookupTable = await waitForLookupTable(connection, plan.address);
    const { blockhash } = await connection.getLatestBlockhash("confirmed");
    const treasurySetup: TransactionInstruction[] = [];
    if (!(await connection.getAccountInfo(teamWsol))) {
      treasurySetup.push(
        createAssociatedTokenAccountIdempotentInstruction(owner, teamWsol, teamTreasury, NATIVE_MINT)
      );
    }
    const createTx = marketCreationV0Transaction({
      payer: owner,
      recentBlockhash: blockhash,
      initializeMarketInstruction: initIx,
      setupInstructions: treasurySetup,
      lookupTable,
    });
    lastSig = await sendVersioned(connection, wallet, createTx);

    const kinds = ["srlp", "hlp", "hlp"] as const;
    for (let i = 0; i < hooked.length; i++) {
      const hookTx = await dusk.write.initializeLpTransferHookTransaction({
        payer: owner,
        market,
        lpMint: hooked[i]!.mint,
        tokenKind: kinds[i],
      });
      lastSig = await sendLegacy(connection, wallet, hookTx.instructions);
    }
  }

  const marketAccount = await dusk.get.market(market);
  const baseReserve = bn(marketAccount.baseSide.reserves.liveReserve);
  const quoteReserve = bn(marketAccount.quoteSide.reserves.liveReserve);
  if (baseReserve === BigInt(0) && quoteReserve === BigInt(0)) {
    const ownerBase = getAssociatedTokenAddressSync(mint, owner, false, TOKEN_PROGRAM_ID);
    const ownerQuote = getAssociatedTokenAddressSync(NATIVE_MINT, owner, false, TOKEN_PROGRAM_ID);
    const srlpMint = asPubkey(marketAccount.srlpMint);
    const ownerSrlp = getAssociatedTokenAddressSync(srlpMint, owner, false, TOKEN_2022_PROGRAM_ID);
    const [baseBal, quoteBal] = await Promise.all([
      connection.getTokenAccountBalance(ownerBase, "confirmed"),
      connection.getTokenAccountBalance(ownerQuote, "confirmed"),
    ]);
    const [baseReserveVault] = deriveMarketReserveVaultAddress(market, mint, programId);
    const [quoteReserveVault] = deriveMarketReserveVaultAddress(market, NATIVE_MINT, programId);
    const [baseYield] = deriveYieldAccountAddress(market, owner, srlpMint, mint, "srlp", programId);
    const [quoteYield] = deriveYieldAccountAddress(
      market,
      owner,
      srlpMint,
      NATIVE_MINT,
      "srlp",
      programId
    );
    const seedTx = await dusk.write.transaction(
      "openLiquidityGates",
      {
        baseDepositAmount: baseBal.value.amount,
        quoteDepositAmount: quoteBal.value.amount,
        minSrlpAmount: "1",
      },
      {
        accounts: {
          market,
          owner,
          baseMint: mint,
          quoteMint: NATIVE_MINT,
          srlpMint,
          baseReserveVault,
          quoteReserveVault,
          ownerBaseAccount: ownerBase,
          ownerQuoteAccount: ownerQuote,
          ownerSrlpAccount: ownerSrlp,
          baseYieldAccount: baseYield,
          quoteYieldAccount: quoteYield,
        },
      }
    );
    lastSig = await sendLegacy(connection, wallet, seedTx.instructions);

    // Lock 100% of claimable bootstrap srLP forever (do NOT remove_liquidity).
    const burnSig = await lockBootstrapSrlpAtIncinerator({
      connection,
      wallet,
      srlpMint,
      ownerSrlp,
    });
    if (burnSig) lastSig = burnSig;
  } else {
    // Market already seeded earlier — still ensure platform holds no claimable srLP.
    const srlpMint = asPubkey(marketAccount.srlpMint);
    const ownerSrlp = getAssociatedTokenAddressSync(
      srlpMint,
      owner,
      false,
      TOKEN_2022_PROGRAM_ID
    );
    const burnSig = await lockBootstrapSrlpAtIncinerator({
      connection,
      wallet,
      srlpMint,
      ownerSrlp,
    });
    if (burnSig) lastSig = burnSig;
  }

  const linked = state.gammPool as PublicKey;
  if (linked.equals(PublicKey.default)) {
    const launchpad = getProgram(wallet, connection);
    lastSig = await (launchpad.methods as any)
      .linkDuskMarket()
      .accounts({
        tokenState,
        mint,
        market,
        duskProgram: programId,
        deployer: owner,
      })
      .rpc();
  }

  return lastSig;
}
