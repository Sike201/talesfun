/**
 * Build + send `bootstrap_omnipair_pool`: fund empty LP mint, derive Omnipair `initialize` accounts,
 * then call the launchpad (vault → deployer ATAs + Omnipair CPI).
 */
import { Program, AnchorProvider, BN } from "@coral-xyz/anchor";
import { createHash } from "crypto";
import type { AnchorWallet } from "@solana/wallet-adapter-react";
import {
  ACCOUNT_SIZE,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountInstruction,
  getAssociatedTokenAddressSync,
  MINT_SIZE,
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  AddressLookupTableProgram,
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  Transaction,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  type AccountInfo,
  type AddressLookupTableAccount,
  type MessageV0,
} from "@solana/web3.js";
import bs58 from "bs58";
import { IDL as OmnipairIdl } from "@omnipair/program-interface";
import type { Omnipair } from "@omnipair/program-interface";

import {
  getProgram,
  getReadOnlyProgram,
  getSolVaultPDA,
  getTokenStatePDA,
  getMetadataPDA,
  PROGRAM_ID as LAUNCHPAD_PROGRAM_ID,
} from "./program";
import {
  isDuplicateAlreadyProcessedSendError,
  isTransientConfirmationFailure,
  pollSignatureUntilConfirmed,
} from "./txConfirmPoll";
import {
  OMNIPAIR_PROGRAM_ID,
  deriveOmnipairCollateralVault,
  deriveOmnipairFutarchyAuthority,
  deriveOmnipairPair,
  deriveOmnipairReserveVault,
  omnipairEventAuthorityPda,
} from "./omnipairProgram";

const TOKEN_2022 = new PublicKey(
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
);
const MPL_TOKEN_METADATA = new PublicKey(
  "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s"
);

const OMNIPAIR_VERSION = 1;

/** Matches Solana `Pubkey` Ord: lexicographic compare of 32-byte big-endian buffers (not base58 string compare). */
function orderOmnipairMintsLex(a: PublicKey, b: PublicKey): [PublicKey, PublicKey] {
  const ab = a.toBytes();
  const bb = b.toBytes();
  let cmp = 0;
  for (let i = 0; i < 32; i++) {
    if (ab[i] !== bb[i]) {
      cmp = ab[i]! < bb[i]! ? -1 : 1;
      break;
    }
  }
  if (cmp === 0) {
    throw new Error("Omnipair bootstrap: project mint and WSOL must differ");
  }
  return cmp < 0 ? [a, b] : [b, a];
}

function u16le(n: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(n, 0);
  return b;
}

function u64le(n: bigint): Uint8Array {
  const buf = new ArrayBuffer(8);
  const view = new DataView(buf);
  view.setBigUint64(0, n, true); // true = little endian
  return new Uint8Array(buf);
}

/** Preimage for Omnipair `params_hash` (same fields/order as `omnipair_cpi::omnipair_params_hash_matches`; excludes `initial_rate_bps`). */
export function buildOmnipairParamsHashPreimage(params: {
  swapFeeBps: number;
  halfLife: bigint;
  fixedCfBps?: number;
  targetUtilStartBps?: bigint;
  targetUtilEndBps?: bigint;
  rateHalfLifeMs?: bigint;
  minRateBps?: bigint;
  maxRateBps?: bigint;
}): Buffer {
  return Buffer.concat([
    Buffer.from([OMNIPAIR_VERSION]),
    u16le(params.swapFeeBps),
    u64le(params.halfLife),
    u16le(params.fixedCfBps ?? 0),
    u64le(params.targetUtilStartBps ?? BigInt(0)),
    u64le(params.targetUtilEndBps ?? BigInt(0)),
    u64le(params.rateHalfLifeMs ?? BigInt(0)),
    u64le(params.minRateBps ?? BigInt(0)),
    u64le(params.maxRateBps ?? BigInt(0)),
  ]);
}

/** Matches `InitializeAndBootstrap::validate` params-hash preimage in omnipair-rs. */
export function computeOmnipairParamsHash(params: {
  swapFeeBps: number;
  halfLife: bigint;
  fixedCfBps?: number;
  targetUtilStartBps?: bigint;
  targetUtilEndBps?: bigint;
  rateHalfLifeMs?: bigint;
  minRateBps?: bigint;
  maxRateBps?: bigint;
}): number[] {
  const payload = buildOmnipairParamsHashPreimage(params);
  return [...createHash("sha256").update(payload).digest()];
}

export type DefaultOmnipairPoolParams = {
  swapFeeBps: number;
  halfLife: bigint;
};

const DEFAULT_POOL: DefaultOmnipairPoolParams = {
  swapFeeBps: 30,
  halfLife: BigInt(3_600_000),
};

/** Omnipair `initialize` account order (IDL); `remainingAccounts` for launchpad must match. */
const OMNIPAIR_INITIALIZE_ACCOUNT_LABELS = [
  "deployer",
  "token0_mint",
  "token1_mint",
  "pair",
  "futarchy_authority",
  "rate_model",
  "lp_mint",
  "lp_token_metadata",
  "deployer_lp_token_account",
  "reserve0_vault",
  "reserve1_vault",
  "collateral0_vault",
  "collateral1_vault",
  "deployer_token0_account",
  "deployer_token1_account",
  "team_treasury",
  "team_treasury_wsol_account",
  "system_program",
  "token_program",
  "token_2022_program",
  "token_metadata_program",
  "associated_token_program",
  "rent",
  "event_authority",
  "program",
] as const;

/** Matches `omnipair_cpi::OMNIPAIR_INITIALIZE_DISCRIMINATOR` and `@omnipair/program-interface` idl `initialize`. */
const OMNIPAIR_INITIALIZE_DISCRIMINATOR_BYTES = [
  175, 175, 109, 31, 13, 152, 155, 237,
] as const;

function omnipairBootstrapDebugEnabled(): boolean {
  return (
    process.env.NODE_ENV === "development" ||
    (typeof process !== "undefined" &&
      process.env.NEXT_PUBLIC_DEBUG_OMNIPAIR_INIT === "1")
  );
}

type ChainShape = {
  exists: boolean;
  ownerProgramId: string | null;
  dataLength: number;
  lamports: number;
};

function chainShape(info: AccountInfo<Buffer> | null | undefined): ChainShape {
  if (info == null) {
    return {
      exists: false,
      ownerProgramId: null,
      dataLength: 0,
      lamports: 0,
    };
  }
  return {
    exists: true,
    ownerProgramId: info.owner.toBase58(),
    dataLength: info.data.length,
    lamports: info.lamports,
  };
}

/**
 * Always runs immediately before signing bootstrap tx 2. Loud, explicit Omnipair `initialize` inputs.
 */
async function logPreBootstrapTx2OmnipairInitializeAudit(params: {
  connection: Connection;
  teamTreasury: PublicKey;
  teamTreasuryWsol: PublicKey;
  lpMint: PublicKey;
  lpTokenMetadata: PublicKey;
  deployerLpTokenAccount: PublicKey;
  deployerToken0Account: PublicKey;
  deployerToken1Account: PublicKey;
  /** SPL Token or Token-2022 program owning the project mint (and deployer token1 ATA). */
  deployerToken1TokenProgram: PublicKey;
  reserve0: PublicKey;
  reserve1: PublicKey;
  collateral0: PublicKey;
  collateral1: PublicKey;
}): Promise<void> {
  const tokenkeg = TOKEN_PROGRAM_ID.toBase58();
  const token1OwnerExpected = params.deployerToken1TokenProgram.toBase58();
  const mpl = MPL_TOKEN_METADATA.toBase58();

  const keys = [
    params.teamTreasury,
    params.teamTreasuryWsol,
    params.lpMint,
    params.deployerToken0Account,
    params.deployerToken1Account,
    params.deployerLpTokenAccount,
    params.lpTokenMetadata,
    params.reserve0,
    params.reserve1,
    params.collateral0,
    params.collateral1,
  ] as const;

  const infos = await params.connection.getMultipleAccountsInfo(
    [...keys],
    { commitment: "confirmed" }
  );

  const tt = chainShape(infos[0]);
  const tw = chainShape(infos[1]);
  const lp = chainShape(infos[2]);
  const dt0 = chainShape(infos[3]);
  const dt1 = chainShape(infos[4]);
  const dlp = chainShape(infos[5]);
  const meta = chainShape(infos[6]);
  const r0 = chainShape(infos[7]);
  const r1 = chainShape(infos[8]);
  const c0 = chainShape(infos[9]);
  const c1 = chainShape(infos[10]);

  const issues: string[] = [];

  if (!tt.exists) {
    issues.push("team_treasury: missing on-chain");
  }

  if (!tw.exists) {
    issues.push("team_treasury_wsol_account: missing");
  } else if (tw.ownerProgramId !== tokenkeg || tw.dataLength !== ACCOUNT_SIZE) {
    issues.push(
      `team_treasury_wsol_account: invalid SPL token account (owner=${tw.ownerProgramId}, len=${tw.dataLength}; want ${tokenkeg}, ${ACCOUNT_SIZE})`
    );
  }

  if (!lp.exists) {
    issues.push("lp_mint: missing after prep tx");
  } else if (lp.ownerProgramId !== tokenkeg || lp.dataLength !== MINT_SIZE) {
    issues.push(
      `lp_mint: bad shape (owner=${lp.ownerProgramId}, len=${lp.dataLength}; want ${tokenkeg}, ${MINT_SIZE})`
    );
  }

  const expectSplAta = (label: string, s: ChainShape, expectedOwnerB58: string) => {
    if (!s.exists) {
      issues.push(`${label}: missing (launchpad will fund this ATA from vaults; it must exist)`);
    } else if (s.ownerProgramId !== expectedOwnerB58 || s.dataLength !== ACCOUNT_SIZE) {
      issues.push(
        `${label}: not a valid token account for this mint program (owner=${s.ownerProgramId}, len=${s.dataLength}; want owner ${expectedOwnerB58}, len ${ACCOUNT_SIZE})`
      );
    }
  };
  expectSplAta("deployer_token0_account", dt0, tokenkeg);
  expectSplAta("deployer_token1_account", dt1, token1OwnerExpected);

  if (dlp.exists && (dlp.ownerProgramId !== tokenkeg || dlp.dataLength !== ACCOUNT_SIZE)) {
    issues.push(
      `deployer_lp_token_account: unexpected shape (owner=${dlp.ownerProgramId}, len=${dlp.dataLength})`
    );
  }

  if (meta.exists && meta.ownerProgramId !== mpl) {
    issues.push(
      `lp_token_metadata: exists but owner is ${meta.ownerProgramId} (expected MPL ${mpl})`
    );
  }

  for (const [label, v] of [
    ["reserve0_vault", r0],
    ["reserve1_vault", r1],
    ["collateral0_vault", c0],
    ["collateral1_vault", c1],
  ] as const) {
    if (v.exists) {
      issues.push(`${label}: already exists (owner=${v.ownerProgramId}, len=${v.dataLength})`);
    }
  }

  let mostSuspiciousHint: string;
  if (!lp.exists || lp.ownerProgramId !== tokenkeg || lp.dataLength !== MINT_SIZE) {
    mostSuspiciousHint = "lp_mint";
  } else if (!tw.exists || tw.ownerProgramId !== tokenkeg || tw.dataLength !== ACCOUNT_SIZE) {
    mostSuspiciousHint = "team_treasury_wsol_account";
  } else if (!dt0.exists || dt0.ownerProgramId !== tokenkeg || dt0.dataLength !== ACCOUNT_SIZE) {
    mostSuspiciousHint = "deployer_token0_account";
  } else if (
    !dt1.exists ||
    dt1.ownerProgramId !== token1OwnerExpected ||
    dt1.dataLength !== ACCOUNT_SIZE
  ) {
    mostSuspiciousHint = "deployer_token1_account";
  } else if (dlp.exists && (dlp.ownerProgramId !== tokenkeg || dlp.dataLength !== ACCOUNT_SIZE)) {
    mostSuspiciousHint = "deployer_lp_token_account";
  } else if (meta.exists && meta.ownerProgramId !== mpl) {
    mostSuspiciousHint = "lp_token_metadata";
  } else if (r0.exists || r1.exists || c0.exists || c1.exists) {
    mostSuspiciousHint = "reserve/collateral vault (pre-existing)";
  } else {
    mostSuspiciousHint =
      "none flagged by this audit; next suspects: rate_model, Metaplex init, or Omnipair stack inside Initialize";
  }

  const banner =
    "\n" +
    "================================================================================\n" +
    "[omnipair bootstrap] PRE-BOOTSTRAP TX2 — Omnipair Initialize runtime audit (READ THIS)\n" +
    "================================================================================";

  console.warn(banner);
  console.warn("[omnipair bootstrap] Derived / expected pubkeys (initialize CPI):");
  console.warn(
    JSON.stringify(
      {
        team_treasury: params.teamTreasury.toBase58(),
        team_treasury_wsol_account_derived: params.teamTreasuryWsol.toBase58(),
        lp_token_metadata_derived: params.lpTokenMetadata.toBase58(),
        deployer_lp_token_account_derived: params.deployerLpTokenAccount.toBase58(),
      },
      null,
      2
    )
  );

  console.warn("[omnipair bootstrap] team_treasury (on-chain):");
  console.warn(JSON.stringify({ ...tt, pubkey: params.teamTreasury.toBase58() }, null, 2));
  console.warn("[omnipair bootstrap] team_treasury_wsol_account (on-chain):");
  console.warn(JSON.stringify({ ...tw, pubkey: params.teamTreasuryWsol.toBase58() }, null, 2));
  console.warn("[omnipair bootstrap] lp_mint (on-chain):");
  console.warn(JSON.stringify({ ...lp, pubkey: params.lpMint.toBase58() }, null, 2));
  console.warn("[omnipair bootstrap] deployer_token0_account (on-chain):");
  console.warn(JSON.stringify({ ...dt0, pubkey: params.deployerToken0Account.toBase58() }, null, 2));
  console.warn("[omnipair bootstrap] deployer_token1_account (on-chain):");
  console.warn(JSON.stringify({ ...dt1, pubkey: params.deployerToken1Account.toBase58() }, null, 2));
  console.warn("[omnipair bootstrap] deployer_lp_token_account (on-chain):");
  console.warn(
    JSON.stringify({ ...dlp, pubkey: params.deployerLpTokenAccount.toBase58() }, null, 2)
  );
  console.warn("[omnipair bootstrap] lp_token_metadata PDA (on-chain):");
  console.warn(JSON.stringify({ ...meta, pubkey: params.lpTokenMetadata.toBase58() }, null, 2));
  console.warn("[omnipair bootstrap] vault PDAs (expect absent):");
  console.warn(
    JSON.stringify(
      {
        reserve0_vault: { ...r0, pubkey: params.reserve0.toBase58() },
        reserve1_vault: { ...r1, pubkey: params.reserve1.toBase58() },
        collateral0_vault: { ...c0, pubkey: params.collateral0.toBase58() },
        collateral1_vault: { ...c1, pubkey: params.collateral1.toBase58() },
      },
      null,
      2
    )
  );

  const summaryLine = `[omnipair bootstrap] SUMMARY mostSuspiciousHint=${mostSuspiciousHint} issues=${JSON.stringify(issues)}`;
  console.warn(summaryLine);
  if (issues.length > 0) {
    console.error("[omnipair bootstrap] AUDIT ISSUES (non-empty):", issues);
  }
  console.warn(
    "================================================================================\n"
  );
}

/** One-shot snapshot:25 accounts, PDAs, params hash preimage, full ix data (placeholders; launchpad rewrites ix data on CPI). */
function logOmnipairBootstrapRuntimeSnapshot(params: {
  omniIx: TransactionInstruction;
  token0: PublicKey;
  token1: PublicKey;
  pairPda: PublicKey;
  futarchyPda: PublicKey;
  eventAuthority: PublicKey;
  rateModelPubkey: PublicKey;
  deployer: PublicKey;
  paramsHash: number[];
  poolParams: DefaultOmnipairPoolParams;
}): void {
  if (!omnipairBootstrapDebugEnabled()) return;

  const { omniIx } = params;
  const data = Buffer.from(omniIx.data);
  const discArr = [...data.subarray(0, 8)];
  const discOk =
    discArr.length === OMNIPAIR_INITIALIZE_DISCRIMINATOR_BYTES.length &&
    discArr.every((b, i) => b === OMNIPAIR_INITIALIZE_DISCRIMINATOR_BYTES[i]);

  const preimage = buildOmnipairParamsHashPreimage({
    swapFeeBps: params.poolParams.swapFeeBps,
    halfLife: params.poolParams.halfLife,
  });
  const paramsHashBuf = Buffer.from(params.paramsHash);
  const recomputed = Buffer.from(
    createHash("sha256").update(preimage).digest()
  );
  const paramsHashMatchesPreimage = recomputed.equals(paramsHashBuf);

  const [expPair] = deriveOmnipairPair(
    params.token0,
    params.token1,
    params.paramsHash
  );
  const [expFa] = deriveOmnipairFutarchyAuthority();
  const expEa = omnipairEventAuthorityPda();
  const [expR0] = deriveOmnipairReserveVault(params.pairPda, params.token0);
  const [expR1] = deriveOmnipairReserveVault(params.pairPda, params.token1);
  const [expC0] = deriveOmnipairCollateralVault(params.pairPda, params.token0);
  const [expC1] = deriveOmnipairCollateralVault(params.pairPda, params.token1);

  const keys = omniIx.keys;
  const labelAt = (i: number) =>
    OMNIPAIR_INITIALIZE_ACCOUNT_LABELS[i] ?? `unknown_${i}`;

  const mismatch = (i: number, expected: PublicKey, name: string) => {
    const got = keys[i]?.pubkey;
    if (!got || !got.equals(expected)) {
      return `${name}[${i}] expected ${expected.toBase58()} got ${got?.toBase58() ?? "missing"}`;
    }
    return null;
  };

  const pdaMismatches = [
    mismatch(1, params.token0, "token0_mint"),
    mismatch(2, params.token1, "token1_mint"),
    mismatch(3, expPair, "pair"),
    mismatch(4, expFa, "futarchy_authority"),
    mismatch(9, expR0, "reserve0_vault"),
    mismatch(10, expR1, "reserve1_vault"),
    mismatch(11, expC0, "collateral0_vault"),
    mismatch(12, expC1, "collateral1_vault"),
    mismatch(23, expEa, "event_authority"),
    mismatch(24, OMNIPAIR_PROGRAM_ID, "program"),
  ].filter((x): x is string => x != null);

  const signerIssues: string[] = [];
  if (!keys[0]?.isSigner) signerIssues.push("deployer[0] must be signer");
  if (!keys[0]?.pubkey.equals(params.deployer)) {
    signerIssues.push(
      `deployer[0] pubkey ${keys[0]?.pubkey.toBase58()} !== wallet ${params.deployer.toBase58()}`
    );
  }
  if (!keys[5]?.pubkey.equals(params.rateModelPubkey)) {
    signerIssues.push(
      `rate_model[5] ${keys[5]?.pubkey.toBase58()} !== expected ${params.rateModelPubkey.toBase58()}`
    );
  }
  if (!keys[5]?.isSigner) {
    signerIssues.push("rate_model[5] must be signer (partialSign this keypair on bootstrap tx)");
  }

  const accountsLabeled = keys.map((k, i) => ({
    index: i,
    label: labelAt(i),
    pubkey: k.pubkey.toBase58(),
    isSigner: k.isSigner,
    isWritable: k.isWritable,
  }));

  console.info("[omnipair bootstrap] runtime snapshot (initialize ix + PDA/signer checks)", {
    omnipairProgramId: OMNIPAIR_PROGRAM_ID.toBase58(),
    ixProgramId: omniIx.programId.toBase58(),
    token0: params.token0.toBase58(),
    token1: params.token1.toBase58(),
    pairPdaDerived: params.pairPda.toBase58(),
    pairPdaMatchesRecompute: expPair.equals(params.pairPda),
    futarchyAuthority: params.futarchyPda.toBase58(),
    eventAuthorityDerived: params.eventAuthority.toBase58(),
    eventAuthorityMatchesRecompute: expEa.equals(params.eventAuthority),
    rateModelPubkey: params.rateModelPubkey.toBase58(),
    rateModelSignsOuterTx:
      "partialSign + wallet.signTransaction on v0 msg (see bootstrap flow)",
    paramsHashPreimageHex: preimage.toString("hex"),
    paramsHashBytesHex: paramsHashBuf.toString("hex"),
    paramsHashMatchesRustLaunchpadPreimage: paramsHashMatchesPreimage,
    instructionDataLengthBytes: data.length,
    discriminatorBytes: discArr,
    discriminatorMatchesIdl: discOk,
    instructionDataHexFull: data.toString("hex"),
    argsBodyHex: data.subarray(8).toString("hex"),
    accountCount: keys.length,
    accountsLabeledJsonLineCount: accountsLabeled.length,
    pdaVersusInstructionMismatches: pdaMismatches,
    signerIssues,
  });
  console.info(
    "[omnipair bootstrap] accountsLabeled (full JSON array, not collapsed):\n" +
      JSON.stringify(accountsLabeled, null, 2)
  );

  if (pdaMismatches.length > 0 || signerIssues.length > 0) {
    console.error(
      "[omnipair bootstrap] runtime verification failed (fix before expecting CPI to succeed)",
      { pdaMismatches, signerIssues }
    );
  }
}

function logLabeledOmnipairMetas(
  keys: readonly { pubkey: PublicKey; isSigner: boolean; isWritable: boolean }[]
): void {
  const rows = keys.map((k, i) => ({
    index: i,
    label: OMNIPAIR_INITIALIZE_ACCOUNT_LABELS[i] ?? `unknown_${i}`,
    pubkey: k.pubkey.toBase58(),
    isSigner: k.isSigner,
    isWritable: k.isWritable,
  }));
  console.info(
    "[omnipair bootstrap] initialize account metas (JSON):\n" +
      JSON.stringify(rows, null, 2)
  );
}

/** Legacy tx limit; splitting prep vs bootstrap avoids oversized single messages. */
const LEGACY_TX_MAX_BYTES = 1232;

/**
 * Bootstrap tx 2 runs launchpad → Omnipair `initialize` → Metaplex metadata CPI; default ~200k CU is too low.
 * Solana max per tx is 1.4M; use env override if simulate shows you need less.
 */
const OMNIPAIR_BOOTSTRAP_COMPUTE_UNIT_LIMIT = Number(
  process.env.NEXT_PUBLIC_OMNIPAIR_BOOTSTRAP_COMPUTE_UNITS ?? 1_400_000
);
/** Micro-lamports per CU;0 = omit setComputeUnitPrice (no priority fee). */
const OMNIPAIR_BOOTSTRAP_COMPUTE_UNIT_PRICE_MICRO = Number(
  process.env.NEXT_PUBLIC_OMNIPAIR_BOOTSTRAP_CU_PRICE_MICRO_LAMPORTS ?? 0
);

function clampedBootstrapComputeUnitLimit(): number {
  return Math.min(
    Math.max(OMNIPAIR_BOOTSTRAP_COMPUTE_UNIT_LIMIT, 1),
    1_400_000
  );
}

function bootstrapTx2ComputeBudgetInstructions(): TransactionInstruction[] {
  const limit = clampedBootstrapComputeUnitLimit();
  const out: TransactionInstruction[] = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: limit }),
  ];
  if (OMNIPAIR_BOOTSTRAP_COMPUTE_UNIT_PRICE_MICRO > 0) {
    out.push(
      ComputeBudgetProgram.setComputeUnitPrice({
        microLamports: OMNIPAIR_BOOTSTRAP_COMPUTE_UNIT_PRICE_MICRO,
      })
    );
  }
  return out;
}

function logLegacyTxDebug(label: string, tx: Transaction): void {
  const msg = tx.compileMessage();
  const accountKeys = msg.accountKeys;
  let serializedBytes = 0;
  try {
    serializedBytes = tx.serialize({
      requireAllSignatures: false,
      verifySignatures: false,
    }).length;
  } catch {
    serializedBytes = 0;
  }
  const signerCount = accountKeys.filter((k, i) => msg.isAccountSigner(i)).length;
  console.info("[omnipair bootstrap]", label, {
    instructions: tx.instructions.length,
    signerSlots: tx.signatures.length,
    signersAmongAccountKeys: signerCount,
    uniqueAccountKeys: accountKeys.length,
    serializedBytes,
    overLegacyLimit: serializedBytes > LEGACY_TX_MAX_BYTES,
  });
}

const EXTEND_ALT_CHUNK = 25;

function signatureFromLegacyTx(tx: Transaction): string {
  const buf = tx.signature;
  if (!buf || buf.length === 0) {
    throw new Error("Legacy transaction missing fee-payer signature (cannot recover duplicate tx id)");
  }
  return bs58.encode(buf);
}

function signatureFromVersionedTx(tx: VersionedTransaction): string {
  const sig = tx.signatures[0];
  if (!sig || sig.length !== 64 || sig.every((b) => b === 0)) {
    throw new Error("Versioned transaction missing fee-payer signature (cannot recover duplicate tx id)");
  }
  return bs58.encode(sig);
}

/**
 * Confirm sends without `connection.confirmTransaction` (avoids flaky WS + blockheight expiry UX).
 * Duplicate / already-processed on send recovers signature from the signed tx and polls.
 */
async function sendRawConfirmWithDuplicateRecovery(params: {
  connection: Connection;
  serialize: () => Uint8Array;
  recoverSignature: () => string;
  blockhash: string;
  lastValidBlockHeight: number;
  label: string;
}): Promise<string> {
  const { connection, serialize, recoverSignature, label } = params;
  let submittedSig: string | null = null;
  try {
    submittedSig = await connection.sendRawTransaction(serialize(), {
      skipPreflight: false,
      preflightCommitment: "confirmed",
      maxRetries: 3,
    });
    console.info("[omnipair bootstrap] submitted signature", {
      label,
      signature: submittedSig,
    });
  } catch (e) {
    if (!isDuplicateAlreadyProcessedSendError(e)) {
      console.warn("[omnipair bootstrap] sendRawTransaction error", {
        label,
        error: e instanceof Error ? e.message : e,
      });
      throw e;
    }
    submittedSig = recoverSignature();
    console.info("[omnipair bootstrap] duplicate/already-processed on send", {
      label,
      recoveredSignature: submittedSig,
    });
  }

  console.info("[omnipair bootstrap] confirming via HTTP poll (not websocket)", {
    label,
    signature: submittedSig,
  });
  await pollSignatureUntilConfirmed(connection, submittedSig, { timeoutMs: 120_000 });
  console.info("[omnipair bootstrap] poll confirmed OK", { label, signature: submittedSig });
  return submittedSig;
}

async function fetchGammPoolB58(
  connection: Connection,
  _wallet: AnchorWallet,
  mint: PublicKey
): Promise<string> {
  const ro = getReadOnlyProgram(connection);
  const [tokenState] = getTokenStatePDA(mint);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const state = await (ro.account as any).tokenState.fetch(tokenState);
  return state.gammPool.toBase58() as string;
}

function gammPoolIsNonDefault(gammB58: string): boolean {
  return Boolean(gammB58 && gammB58 !== PublicKey.default.toBase58());
}

async function verifyBootstrapSetGammPool(params: {
  connection: Connection;
  wallet: AnchorWallet;
  mint: PublicKey;
  bootstrapSig: string;
}): Promise<void> {
  const { connection, wallet, mint, bootstrapSig } = params;
  let gamm = await fetchGammPoolB58(connection, wallet, mint);
  console.info("[omnipair bootstrap] final state verification (gamm_pool)", {
    bootstrapSig,
    gammPool: gamm,
    nonDefault: gammPoolIsNonDefault(gamm),
  });

  if (!gammPoolIsNonDefault(gamm)) {
    await new Promise((r) => setTimeout(r, 2000));
    gamm = await fetchGammPoolB58(connection, wallet, mint);
    console.info("[omnipair bootstrap] gamm_pool refetch after delay", {
      gammPool: gamm,
      nonDefault: gammPoolIsNonDefault(gamm),
    });
  }

  if (!gammPoolIsNonDefault(gamm)) {
    console.info("[omnipair bootstrap] final decision: FAILURE (gamm_pool still default)", {
      bootstrapSig,
      gammPool: gamm,
    });
    throw new Error(
      `Omnipair bootstrap did not set gamm_pool (still default after refetch). Last bootstrap sig: ${bootstrapSig}.`
    );
  }

  console.info("[omnipair bootstrap] final decision: SUCCESS (gamm_pool set)", {
    bootstrapSig,
    gammPool: gamm,
  });
}

// TODO: revert to env — restore reading `NEXT_PUBLIC_OMNIPAIR_BOOTSTRAP_ALT` / `OMNIPAIR_BOOTSTRAP_ALT`
// once Next inlines the client env correctly; this hardcode is temporary for bootstrap testing.
const TEMP_BOOTSTRAP_ALT_ADDRESS = "3npcfnabwUQxvVhGgVtsp62nXpZu4VMpBh8f9ry9zukk";

function readBootstrapAltAddress(): PublicKey {
  return new PublicKey(TEMP_BOOTSTRAP_ALT_ADDRESS);
}

function uniquePubkeys(keys: PublicKey[]): PublicKey[] {
  const m = new Map<string, PublicKey>();
  for (const k of keys) m.set(k.toBase58(), k);
  return [...m.values()];
}

/**
 * Accounts that may be moved into an ALT (signers + invoked launchpad program stay in static keys).
 */
function altExtendCandidates(
  bootstrapIx: TransactionInstruction,
  feePayer: PublicKey,
  rateModelPk: PublicKey
): PublicKey[] {
  const skip = new Set([
    feePayer.toBase58(),
    rateModelPk.toBase58(),
    LAUNCHPAD_PROGRAM_ID.toBase58(),
  ]);
  const out: PublicKey[] = [];
  for (const m of bootstrapIx.keys) {
    if (!skip.has(m.pubkey.toBase58())) out.push(m.pubkey);
  }
  return uniquePubkeys(out);
}

async function ensureAltContainsAddresses(
  connection: Connection,
  wallet: AnchorWallet,
  lookupTableAddress: PublicKey,
  addresses: PublicKey[]
): Promise<AddressLookupTableAccount> {
  const fetchAlt = async () => {
    const r = await connection.getAddressLookupTable(lookupTableAddress, {
      commitment: "confirmed",
    });
    if (!r.value) {
      throw new Error(`Address lookup table not found: ${lookupTableAddress.toBase58()}`);
    }
    return r.value;
  };

  let alt = await fetchAlt();
  const onChainAuthority = alt.state.authority;

  console.info("[omnipair bootstrap] ALT before extend", {
    connectedWallet: wallet.publicKey.toBase58(),
    configuredAltAddress: lookupTableAddress.toBase58(),
    onChainAltAuthority: onChainAuthority?.toBase58() ?? null,
    authorityMatchesWallet: onChainAuthority
      ? onChainAuthority.equals(wallet.publicKey)
      : false,
  });

  if (!onChainAuthority) {
    throw new Error(
      `Address lookup table ${lookupTableAddress.toBase58()} has no authority on-chain (deactivated or invalid). ` +
        `Create a new ALT with frontend/scripts/create-omnipair-bootstrap-alt.ts and update NEXT_PUBLIC_OMNIPAIR_BOOTSTRAP_ALT.`
    );
  }

  if (!onChainAuthority.equals(wallet.publicKey)) {
    throw new Error(
      `Omnipair bootstrap: your connected wallet (${wallet.publicKey.toBase58()}) is not the authority for ` +
        `NEXT_PUBLIC_OMNIPAIR_BOOTSTRAP_ALT (${lookupTableAddress.toBase58()}). ` +
        `On-chain ALT authority is ${onChainAuthority.toBase58()}. ` +
        `Either connect Phantom (or your wallet) as that authority, or create a new ALT with a keypair that matches the wallet you use in the app ` +
        `(see create-omnipair-bootstrap-alt.ts + set the new address in .env.local).`
    );
  }

  const needed = uniquePubkeys(addresses);
  let missing = needed.filter(
    (pk) => !alt.state.addresses.some((a) => a.equals(pk))
  );

  while (missing.length > 0) {
    const chunk = missing.slice(0, EXTEND_ALT_CHUNK);
    const extendIx = AddressLookupTableProgram.extendLookupTable({
      payer: wallet.publicKey,
      authority: wallet.publicKey,
      lookupTable: lookupTableAddress,
      addresses: chunk,
    });
    const extTx = new Transaction().add(extendIx);
    extTx.feePayer = wallet.publicKey;
    const bh = await connection.getLatestBlockhash("confirmed");
    extTx.recentBlockhash = bh.blockhash;
    const signedExt = await wallet.signTransaction(extTx);
    const extSig = await sendRawConfirmWithDuplicateRecovery({
      connection,
      serialize: () => signedExt.serialize(),
      recoverSignature: () => signatureFromLegacyTx(signedExt),
      blockhash: bh.blockhash,
      lastValidBlockHeight: bh.lastValidBlockHeight,
      label: `ALT extend (+${chunk.length} addresses)`,
    });
    console.info("[omnipair bootstrap] extended ALT; tx:", extSig, "added:", chunk.length);

    alt = await fetchAlt();
    missing = needed.filter(
      (pk) => !alt.state.addresses.some((a) => a.equals(pk))
    );
  }

  return alt;
}

function logBootstrapV0Debug(params: {
  label: string;
  legacyTx: Transaction;
  vtx: VersionedTransaction;
  lookupTableKey: PublicKey;
}): void {
  const { legacyTx, vtx, lookupTableKey, label } = params;
  let legacyBytes = 0;
  try {
    legacyBytes = legacyTx.serialize({
      requireAllSignatures: false,
      verifySignatures: false,
    }).length;
  } catch {
    legacyBytes = 0;
  }
  const v0Bytes = vtx.serialize().length;
  const msg = vtx.message;
  const v0 = msg.version === 0 ? (msg as MessageV0) : null;
  console.info("[omnipair bootstrap]", label, {
    legacySerializedBytes: legacyBytes,
    v0SerializedBytes: v0Bytes,
    v0StaticAccountKeys: v0?.staticAccountKeys.length ?? 0,
    v0AddressTableLookups: v0?.addressTableLookups.map((l) => ({
      lookupTable: l.accountKey.toBase58(),
      writableIndexes: l.writableIndexes.length,
      readonlyIndexes: l.readonlyIndexes.length,
    })),
    lookupTableAccountUsed: lookupTableKey.toBase58(),
    accountMetasInIx: legacyTx.instructions[0]?.keys.length ?? 0,
    underLegacyLimit: v0Bytes <= LEGACY_TX_MAX_BYTES,
  });
}

/**
 * `team_treasury` is only a pubkey in futarchy config until it holds lamports. Fund via devnet airdrop when possible;
 * otherwise user must send SOL to that address first (mainnet / RPCs without airdrop).
 */
async function ensureTeamTreasurySystemAccountIfMissing(params: {
  connection: Connection;
  teamTreasury: PublicKey;
}): Promise<{ treasuryFundingPrepRan: boolean }> {
  const info = await params.connection.getAccountInfo(params.teamTreasury, "confirmed");
  if (info != null) {
    console.info("[omnipair bootstrap] team_treasury system account: already exists", {
      pubkey: params.teamTreasury.toBase58(),
      lamports: info.lamports,
      treasuryFundingPrepRan: false,
    });
    return { treasuryFundingPrepRan: false };
  }

  const rent = await params.connection.getMinimumBalanceForRentExemption(0);
  const fundAmount = Math.max(rent, 15_000);

  try {
    const sig = await params.connection.requestAirdrop(params.teamTreasury, fundAmount);
    console.info("[omnipair bootstrap] treasury airdrop submitted", { sig });
    await pollSignatureUntilConfirmed(params.connection, sig, { timeoutMs: 60_000 });
  } catch (e) {
    throw new Error(
      `team_treasury ${params.teamTreasury.toBase58()} has no on-chain system account and automatic ` +
        `funding failed (${e instanceof Error ? e.message : String(e)}). ` +
        `Send at least ${fundAmount} lamports to that pubkey first, or use devnet with an RPC that supports ` +
        `requestAirdrop to the treasury address.`
    );
  }

  console.info("[omnipair bootstrap] team_treasury: treasury pubkey funding prep ran (airdrop)", {
    treasuryPubkey: params.teamTreasury.toBase58(),
    lamports: fundAmount,
    treasuryFundingPrepRan: true,
  });
  return { treasuryFundingPrepRan: true };
}

/** Launchpad transfers vault balances into deployer token0/token1 ATAs before Omnipair CPI; both must exist. */
async function ensureDeployerToken0Token1Atas(params: {
  connection: Connection;
  wallet: AnchorWallet;
  token0: PublicKey;
  token1: PublicKey;
  deployerToken0: PublicKey;
  deployerToken1: PublicKey;
  tokenProgramId0: PublicKey;
  tokenProgramId1: PublicKey;
}): Promise<{
  deployerWsolAtaCreated: boolean;
  deployerProjectTokenAtaCreated: boolean;
}> {
  const infos = await params.connection.getMultipleAccountsInfo(
    [params.deployerToken0, params.deployerToken1],
    { commitment: "confirmed" }
  );

  const valid0 =
    infos[0] != null &&
    infos[0].owner.equals(params.tokenProgramId0) &&
    infos[0].data.length === ACCOUNT_SIZE;
  const valid1 =
    infos[1] != null &&
    infos[1].owner.equals(params.tokenProgramId1) &&
    infos[1].data.length === ACCOUNT_SIZE;

  if (valid0 && valid1) {
    console.info("[omnipair bootstrap] prep deployer ATAs: both already exist", {
      deployerWsolAtaCreated: false,
      deployerProjectTokenAtaCreated: false,
      deployerToken0: params.deployerToken0.toBase58(),
      deployerToken1: params.deployerToken1.toBase58(),
    });
    return { deployerWsolAtaCreated: false, deployerProjectTokenAtaCreated: false };
  }

  if (infos[0] && !valid0) {
    throw new Error(
      `deployer_token0_account ${params.deployerToken0.toBase58()} exists but is not a valid SPL token account for token0`
    );
  }
  if (infos[1] && !valid1) {
    throw new Error(
      `deployer_token1_account ${params.deployerToken1.toBase58()} exists but is not a valid SPL token account for token1`
    );
  }

  const ixs: TransactionInstruction[] = [];
  if (!valid0) {
    ixs.push(
      createAssociatedTokenAccountInstruction(
        params.wallet.publicKey,
        params.deployerToken0,
        params.wallet.publicKey,
        params.token0,
        params.tokenProgramId0,
        ASSOCIATED_TOKEN_PROGRAM_ID
      )
    );
  }
  if (!valid1) {
    ixs.push(
      createAssociatedTokenAccountInstruction(
        params.wallet.publicKey,
        params.deployerToken1,
        params.wallet.publicKey,
        params.token1,
        params.tokenProgramId1,
        ASSOCIATED_TOKEN_PROGRAM_ID
      )
    );
  }

  const tx = new Transaction().add(...ixs);
  tx.feePayer = params.wallet.publicKey;
  const { blockhash, lastValidBlockHeight } =
    await params.connection.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;

  const signed = await params.wallet.signTransaction(tx);
  const sig = await sendRawConfirmWithDuplicateRecovery({
    connection: params.connection,
    serialize: () => signed.serialize(),
    recoverSignature: () => signatureFromLegacyTx(signed),
    blockhash,
    lastValidBlockHeight,
    label: "prep: create deployer token0/token1 ATAs",
  });
  console.info("[omnipair bootstrap] prep deployer token0/token1 ATA tx:", sig);

  const deployerWsolAtaCreated = !valid0;
  const deployerProjectTokenAtaCreated = !valid1;
  console.info("[omnipair bootstrap] prep deployer ATAs summary", {
    deployerWsolAtaCreated,
    deployerProjectTokenAtaCreated,
    deployerToken0: params.deployerToken0.toBase58(),
    deployerToken1: params.deployerToken1.toBase58(),
  });

  return { deployerWsolAtaCreated, deployerProjectTokenAtaCreated };
}

/**
 * Canonical WSOL ATA for `teamTreasury` (native mint). Omnipair expects this exact address.
 * Creates it via Associated Token program when missing; errors if the address is occupied by a non–token account.
 */
async function ensureTeamTreasuryWsolAssociatedTokenAccount(params: {
  connection: Connection;
  wallet: AnchorWallet;
  teamTreasury: PublicKey;
}): Promise<{ ata: PublicKey; createAtaPrepTxSent: boolean }> {
  const ata = getAssociatedTokenAddressSync(
    NATIVE_MINT,
    params.teamTreasury,
    false
  );
  const info = await params.connection.getAccountInfo(ata, "confirmed");

  const tokenkeg = TOKEN_PROGRAM_ID.toBase58();
  const valid =
    info != null &&
    info.owner.equals(TOKEN_PROGRAM_ID) &&
    info.data.length === ACCOUNT_SIZE;

  console.info("[omnipair bootstrap] treasury WSOL ATA (pre–bootstrap-tx2 check)", {
    treasuryWsolAtaPubkey: ata.toBase58(),
    teamTreasuryOwner: params.teamTreasury.toBase58(),
    nativeMint: NATIVE_MINT.toBase58(),
    exists: info != null,
    ownerProgramId: info?.owner.toBase58() ?? null,
    dataLength: info?.data.length ?? 0,
    expectedOwnerProgramId: tokenkeg,
    expectedDataLength: ACCOUNT_SIZE,
    isValidSplTokenAccount: valid,
  });

  if (valid) {
    console.info("[omnipair bootstrap] treasury WSOL ATA ensure complete", {
      createAtaPrepTxSent: false,
      treasuryWsolAtaPubkey: ata.toBase58(),
    });
    return { ata, createAtaPrepTxSent: false };
  }

  if (info != null) {
    throw new Error(
      `team_treasury_wsol_account ${ata.toBase58()} exists but is not a valid SPL Token account for WSOL ` +
        `(owner=${info.owner.toBase58()}, dataLength=${info.data.length}; expected owner ${tokenkeg}, length ${ACCOUNT_SIZE}). ` +
        `The canonical ATA address is fixed by Associated Token derivation — you cannot use a different address. ` +
        `A plain system account or wrong layout at this pubkey must be removed first: drain lamports so the account is deallocated ` +
        `(or close it if your tooling allows), then re-run bootstrap so createAssociatedTokenAccount can allocate the real ATA. ` +
        `If the account is a user wallet (system program, 0 bytes), do not reuse that pubkey as the treasury; set futarchy team treasury to a normal wallet and use only the derived ATA for WSOL.`
    );
  }

  const createAtaIx = createAssociatedTokenAccountInstruction(
    params.wallet.publicKey,
    ata,
    params.teamTreasury,
    NATIVE_MINT,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );

  const tx = new Transaction().add(createAtaIx);
  tx.feePayer = params.wallet.publicKey;
  const { blockhash, lastValidBlockHeight } =
    await params.connection.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;

  console.info("[omnipair bootstrap] prep: creating treasury WSOL ATA (createAssociatedTokenAccount)", {
    treasuryWsolAtaPubkey: ata.toBase58(),
    createAtaPrepRan: true,
  });

  const signed = await params.wallet.signTransaction(tx);
  const sig = await sendRawConfirmWithDuplicateRecovery({
    connection: params.connection,
    serialize: () => signed.serialize(),
    recoverSignature: () => signatureFromLegacyTx(signed),
    blockhash,
    lastValidBlockHeight,
    label: "prep: create team_treasury WSOL ATA",
  });
  console.info("[omnipair bootstrap] treasury WSOL ATA prep tx confirmed:", sig);

  const after = await params.connection.getAccountInfo(ata, "confirmed");
  const ok =
    after != null &&
    after.owner.equals(TOKEN_PROGRAM_ID) &&
    after.data.length === ACCOUNT_SIZE;
  if (!ok) {
    throw new Error(
      `After createAssociatedTokenAccount, treasury WSOL ATA ${ata.toBase58()} still invalid ` +
        `(owner=${after?.owner.toBase58()}, len=${after?.data.length})`
    );
  }

  console.info("[omnipair bootstrap] treasury WSOL ATA ensure complete", {
    createAtaPrepTxSent: true,
    treasuryWsolAtaPubkey: ata.toBase58(),
  });

  return { ata, createAtaPrepTxSent: true };
}

/**
 * Create LP mint account (82 bytes, uninitialized) + submit bootstrap tx.
 * Deployer wallet must hold ≥ ~0.2 SOL (pair fee) + rent for Omnipair-created accounts + fees.
 */
export async function sendBootstrapOmnipairPoolTx(params: {
  connection: Connection;
  wallet: AnchorWallet;
  mint: PublicKey;
  /** Ticker / symbol for LP metadata (ASCII). */
  ticker: string;
  /** Must be http(s) for Omnipair. */
  lpUri: string;
  pool?: DefaultOmnipairPoolParams;
  /** Log full Omnipair `initialize` account list (index, label, pubkey, flags). */
  logAccountMetas?: boolean;
}): Promise<string> {
  const { connection, wallet, mint, ticker, lpUri } = params;
  const pool = params.pool ?? DEFAULT_POOL;

  if (!lpUri.startsWith("http")) {
    throw new Error("lpUri must start with http:// or https:// (Omnipair constraint)");
  }

  const paramsHash = computeOmnipairParamsHash({
    swapFeeBps: pool.swapFeeBps,
    halfLife: pool.halfLife,
  });

  // `mint < NATIVE_MINT` uses JS coercion to base58 strings — wrong vs on-chain `token0 < token1` (byte order).
  const [token0, token1] = orderOmnipairMintsLex(mint, NATIVE_MINT);

  const [pairPda] = deriveOmnipairPair(token0, token1, paramsHash);

  console.info("[omnipair bootstrap] canonical mint order (byte-lexicographic)", {
    projectMint: mint.toBase58(),
    wsolMint: NATIVE_MINT.toBase58(),
    token0: token0.toBase58(),
    token1: token1.toBase58(),
    token0IsWsol: token0.equals(NATIVE_MINT),
    onChainAmountMapping:
      token0.equals(NATIVE_MINT)
        ? "amount0_in=SOL(lamports from vault), amount1_in=project token"
        : "amount0_in=project token, amount1_in=SOL(lamports from vault)",
    omnipairPlaceholderAmounts: "initialize ix uses 1/1 placeholders; launchpad overwrites ix data with vault amounts",
  });
  const [futarchyPda] = deriveOmnipairFutarchyAuthority();

  const futarchyInfo = await connection.getAccountInfo(futarchyPda, "confirmed");
  if (!futarchyInfo) {
    throw new Error(
      `Omnipair global account futarchy_authority is missing on this cluster (${futarchyPda.toBase58()}). ` +
        `Derivation is correct (seed "futarchy_authority", program ${OMNIPAIR_PROGRAM_ID.toBase58()}). ` +
        `Run Omnipair's one-time init_futarchy_authority instruction on the same RPC cluster (devnet/mainnet) before bootstrap. ` +
        `See https://docs.omnipair.fi/developers/overview and omnipair-rs futarchy instructions.`
    );
  }

  const omnipairIdlForCluster = {
    ...OmnipairIdl,
    address: OMNIPAIR_PROGRAM_ID.toBase58(),
  };
  const omniReadonly = new Program(
    omnipairIdlForCluster as Omnipair,
    new AnchorProvider(connection, wallet, { commitment: "confirmed" })
  );
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fa = await (omniReadonly.account as any).futarchyAuthority.fetch(futarchyPda);
  const teamTreasury = fa.recipients.teamTreasury as PublicKey;
  const teamTreasuryWsol = getAssociatedTokenAddressSync(
    NATIVE_MINT,
    teamTreasury,
    false
  );

  const mintAcct = await connection.getAccountInfo(mint, "confirmed");
  if (!mintAcct) {
    throw new Error(`Project mint account not found: ${mint.toBase58()}`);
  }
  const projectTokenProgram = mintAcct.owner.equals(TOKEN_2022) ? TOKEN_2022 : TOKEN_PROGRAM_ID;

  const rateModelKp = Keypair.generate();
  const lpMintKp = Keypair.generate();

  const lpMetadata = getMetadataPDA(lpMintKp.publicKey);
  const deployerLpAta = getAssociatedTokenAddressSync(
    lpMintKp.publicKey,
    wallet.publicKey,
    false
  );
  const deployerToken0 = getAssociatedTokenAddressSync(
    token0,
    wallet.publicKey,
    false,
    TOKEN_PROGRAM_ID
  );
  const deployerToken1 = getAssociatedTokenAddressSync(
    token1,
    wallet.publicKey,
    false,
    projectTokenProgram
  );

  const reserve0 = deriveOmnipairReserveVault(pairPda, token0)[0];
  const reserve1 = deriveOmnipairReserveVault(pairPda, token1)[0];
  const collateral0 = deriveOmnipairCollateralVault(pairPda, token0)[0];
  const collateral1 = deriveOmnipairCollateralVault(pairPda, token1)[0];

  const placeholderArgs = {
    swapFeeBps: pool.swapFeeBps,
    halfLife: new BN(pool.halfLife.toString()),
    fixedCfBps: null,
    targetUtilStartBps: null,
    targetUtilEndBps: null,
    rateHalfLifeMs: null,
    minRateBps: null,
    maxRateBps: null,
    initialRateBps: null,
    paramsHash,
    version: OMNIPAIR_VERSION,
    amount0In: new BN(1),
    amount1In: new BN(1),
    minLiquidityOut: new BN(0),
    lpName: `${ticker} / SOL (Omnipair)`,
    lpSymbol: (() => {
      const base = `${ticker}`.replace(/[^a-zA-Z0-9]/g, "").slice(0, 6);
      const sym = `${base}omLP`;
      return sym.length <= 10 ? sym : sym.slice(0, 10);
    })(),
    lpUri,
  };

  const omniIx = await omniReadonly.methods
    .initialize(placeholderArgs)
    .accounts({
      deployer: wallet.publicKey,
      token0Mint: token0,
      token1Mint: token1,
      pair: pairPda,
      futarchyAuthority: futarchyPda,
      rateModel: rateModelKp.publicKey,
      lpMint: lpMintKp.publicKey,
      lpTokenMetadata: lpMetadata,
      deployerLpTokenAccount: deployerLpAta,
      reserve0Vault: reserve0,
      reserve1Vault: reserve1,
      collateral0Vault: collateral0,
      collateral1Vault: collateral1,
      deployerToken0Account: deployerToken0,
      deployerToken1Account: deployerToken1,
      teamTreasury,
      teamTreasuryWsolAccount: teamTreasuryWsol,
      systemProgram: SystemProgram.programId,
      tokenProgram: TOKEN_PROGRAM_ID,
      token2022Program: TOKEN_2022,
      tokenMetadataProgram: MPL_TOKEN_METADATA,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      rent: SYSVAR_RENT_PUBKEY,
      eventAuthority: omnipairEventAuthorityPda(),
      program: OMNIPAIR_PROGRAM_ID,
    })
    .instruction();

  logOmnipairBootstrapRuntimeSnapshot({
    omniIx,
    token0,
    token1,
    pairPda,
    futarchyPda,
    eventAuthority: omnipairEventAuthorityPda(),
    rateModelPubkey: rateModelKp.publicKey,
    deployer: wallet.publicKey,
    paramsHash,
    poolParams: pool,
  });

  if (
    params.logAccountMetas === true ||
    (typeof process !== "undefined" &&
      process.env.NEXT_PUBLIC_DEBUG_OMNIPAIR_ACCOUNTS === "1")
  ) {
    logLabeledOmnipairMetas(omniIx.keys);
  }

  const higher = getProgram(wallet, connection);

  const [tokenState] = getTokenStatePDA(mint);
  const [solVault] = getSolVaultPDA(mint);
  const tokenVault = getAssociatedTokenAddressSync(mint, solVault, true);

  const config = {
    swapFeeBps: pool.swapFeeBps,
    halfLife: new BN(pool.halfLife.toString()),
    fixedCfBps: null,
    targetUtilStartBps: null,
    targetUtilEndBps: null,
    rateHalfLifeMs: null,
    minRateBps: null,
    maxRateBps: null,
    initialRateBps: null,
    paramsHash,
    version: OMNIPAIR_VERSION,
    minLiquidityOut: new BN(0),
    lpName: placeholderArgs.lpName,
    lpSymbol: placeholderArgs.lpSymbol,
    lpUri,
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const bootstrapIx = await (higher.methods as any)
    .bootstrapOmnipairPool(config)
    .accounts({
      tokenState,
      mint,
      solVault,
      tokenVault,
      deployer: wallet.publicKey,
      wsolMint: NATIVE_MINT,
      systemProgram: SystemProgram.programId,
      tokenProgram: TOKEN_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
    })
    .remainingAccounts(
      omniIx.keys.map((k) => ({
        pubkey: k.pubkey,
        isWritable: k.isWritable,
        isSigner: k.isSigner,
      }))
    )
    .instruction();

  const lamports = await connection.getMinimumBalanceForRentExemption(MINT_SIZE);
  const createMintIx = SystemProgram.createAccount({
    fromPubkey: wallet.publicKey,
    newAccountPubkey: lpMintKp.publicKey,
    lamports,
    space: MINT_SIZE,
    programId: TOKEN_PROGRAM_ID,
  });

  // Single tx: createAccount + bootstrap exceeds Solana legacy 1232-byte cap (~25 Omnipair CPI
  // metas + launchpad accounts + ix data). Prep tx only allocates the uninitialized LP mint.
  const prepTx = new Transaction().add(createMintIx);
  prepTx.feePayer = wallet.publicKey;
  const prepBlock = await connection.getLatestBlockhash("confirmed");
  prepTx.recentBlockhash = prepBlock.blockhash;
  prepTx.partialSign(lpMintKp);
  logLegacyTxDebug("prep (1/2): create LP mint account", prepTx);

  const signedPrep = await wallet.signTransaction(prepTx);
  const prepSig = await sendRawConfirmWithDuplicateRecovery({
    connection,
    serialize: () => signedPrep.serialize(),
    recoverSignature: () => signatureFromLegacyTx(signedPrep),
    blockhash: prepBlock.blockhash,
    lastValidBlockHeight: prepBlock.lastValidBlockHeight,
    label: "prep (1/2) create LP mint",
  });
  console.info("[omnipair bootstrap] prep tx confirmed:", prepSig);

  await ensureTeamTreasurySystemAccountIfMissing({ connection, teamTreasury });

  await ensureTeamTreasuryWsolAssociatedTokenAccount({
    connection,
    wallet,
    teamTreasury,
  });

  await ensureDeployerToken0Token1Atas({
    connection,
    wallet,
    token0,
    token1,
    deployerToken0,
    deployerToken1,
    tokenProgramId0: TOKEN_PROGRAM_ID,
    tokenProgramId1: projectTokenProgram,
  });

  const bootstrapAltKey = readBootstrapAltAddress();
  const altCandidates = altExtendCandidates(
    bootstrapIx,
    wallet.publicKey,
    rateModelKp.publicKey
  );
  console.info("[omnipair bootstrap] ALT extend candidates (unique):", altCandidates.length);

  const lookupAccount = await ensureAltContainsAddresses(
    connection,
    wallet,
    bootstrapAltKey,
    altCandidates
  );

  const bootBlock = await connection.getLatestBlockhash("confirmed");

  const legacyBootstrapRef = new Transaction().add(bootstrapIx);
  legacyBootstrapRef.feePayer = wallet.publicKey;
  legacyBootstrapRef.recentBlockhash = bootBlock.blockhash;
  legacyBootstrapRef.partialSign(rateModelKp);
  logLegacyTxDebug(
    "bootstrap (2/2) legacy reference (same ix; for size comparison only)",
    legacyBootstrapRef
  );

  const computeBudgetIxs = bootstrapTx2ComputeBudgetInstructions();
  console.info("[omnipair bootstrap] bootstrap (2/2) v0 compute budget request", {
    requestedComputeUnitLimit: clampedBootstrapComputeUnitLimit(),
    requestedComputeUnitPriceMicroLamports:
      OMNIPAIR_BOOTSTRAP_COMPUTE_UNIT_PRICE_MICRO > 0
        ? OMNIPAIR_BOOTSTRAP_COMPUTE_UNIT_PRICE_MICRO
        : null,
    note: "Raises CU cap for Omnipair initialize + Metaplex metadata CPI. Override via NEXT_PUBLIC_OMNIPAIR_BOOTSTRAP_COMPUTE_UNITS / _CU_PRICE_MICRO_LAMPORTS.",
  });

  const messageV0 = new TransactionMessage({
    payerKey: wallet.publicKey,
    recentBlockhash: bootBlock.blockhash,
    instructions: [...computeBudgetIxs, bootstrapIx],
  }).compileToV0Message([lookupAccount]);

  const vtx = new VersionedTransaction(messageV0);
  vtx.sign([rateModelKp]);

  logBootstrapV0Debug({
    label: "bootstrap (2/2) versioned (v0 + ALT)",
    legacyTx: legacyBootstrapRef,
    vtx,
    lookupTableKey: bootstrapAltKey,
  });

  await logPreBootstrapTx2OmnipairInitializeAudit({
    connection,
    teamTreasury,
    teamTreasuryWsol,
    lpMint: lpMintKp.publicKey,
    lpTokenMetadata: lpMetadata,
    deployerLpTokenAccount: deployerLpAta,
    deployerToken0Account: deployerToken0,
    deployerToken1Account: deployerToken1,
    deployerToken1TokenProgram: projectTokenProgram,
    reserve0,
    reserve1,
    collateral0,
    collateral1,
  });

  const signedBoot = await wallet.signTransaction(vtx);
  const recoveredBootSig = () => signatureFromVersionedTx(signedBoot);

  let bootSig: string;
  try {
    bootSig = await sendRawConfirmWithDuplicateRecovery({
      connection,
      serialize: () => signedBoot.serialize(),
      recoverSignature: recoveredBootSig,
      blockhash: bootBlock.blockhash,
      lastValidBlockHeight: bootBlock.lastValidBlockHeight,
      label: "bootstrap (2/2) versioned bootstrap_omnipair_pool",
    });
  } catch (e) {
    const recovered = recoveredBootSig();
    console.warn("[omnipair bootstrap] bootstrap (2/2) send/poll threw", {
      error: e instanceof Error ? e.message : e,
      recoveredSignature: recovered,
    });
    if (isTransientConfirmationFailure(e)) {
      try {
        await pollSignatureUntilConfirmed(connection, recovered, { timeoutMs: 90_000 });
        console.info("[omnipair bootstrap] late poll OK after transient error", recovered);
      } catch (pollLateErr) {
        console.warn("[omnipair bootstrap] late poll failed (will still check gamm_pool)", pollLateErr);
      }
      try {
        await verifyBootstrapSetGammPool({
          connection,
          wallet,
          mint,
          bootstrapSig: recovered,
        });
        return recovered;
      } catch (verifyErr) {
        console.warn(
          "[omnipair bootstrap] gamm_pool still not set after transient error recovery",
          verifyErr
        );
      }
    }
    throw e;
  }

  console.info("[omnipair bootstrap] bootstrap tx confirmed:", bootSig);

  await verifyBootstrapSetGammPool({
    connection,
    wallet,
    mint,
    bootstrapSig: bootSig,
  });

  return bootSig;
}
