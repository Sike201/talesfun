import bs58 from "bs58";
import {
  Connection,
  PublicKey,
  type ParsedInstruction,
  type ParsedTransactionWithMeta,
  type PartiallyDecodedInstruction,
} from "@solana/web3.js";
import { NATIVE_MINT } from "@solana/spl-token";
import { OMNIPAIR_PROGRAM_ID } from "@/lib/omnipairProgram";
import {
  fetchGraduatedOmnipairMintsFromChain,
  getReadOnlyProgram,
  getTokenStatePDA,
  chainPhaseLabelFromTokenState,
} from "@/lib/program";
import { listLocalTrades } from "@/lib/localTradeStore";
import { omnipairSwapFillFromParsedTx } from "@/lib/omnipairSwap";
import {
  upsertCanonicalTrade,
  type CanonicalTradeRow,
} from "@/lib/persistCanonicalTrade";

/** Anchor `swap` discriminator from Omnipair IDL. */
const SWAP_IX_DISC = Uint8Array.from([
  248, 198, 158, 145, 225, 117, 135, 200,
]);

const WSOL_B58 = NATIVE_MINT.toBase58();

function isPartiallyDecoded(
  ix: ParsedInstruction | PartiallyDecodedInstruction
): ix is PartiallyDecodedInstruction {
  return (
    "accounts" in ix &&
    Array.isArray((ix as PartiallyDecodedInstruction).accounts) &&
    typeof (ix as PartiallyDecodedInstruction).data === "string"
  );
}

function* iterAllInstructions(tx: ParsedTransactionWithMeta) {
  for (const ix of tx.transaction.message.instructions) {
    yield ix;
  }
  const inner = tx.meta?.innerInstructions ?? [];
  for (const group of inner) {
    for (const ix of group.instructions) {
      yield ix;
    }
  }
}

/**
 * Detect Omnipair `swap` and read trader + side relative to `projectMint` (WSOL ↔ project).
 */
export function parseOmnipairSwapMetaFromTx(
  tx: ParsedTransactionWithMeta,
  omnipairProgram: PublicKey,
  projectMintB58: string
): { userB58: string; side: "buy" | "sell" } | null {
  for (const ix of iterAllInstructions(tx)) {
    if (!isPartiallyDecoded(ix)) continue;
    if (!ix.programId.equals(omnipairProgram)) continue;
    let buf: Uint8Array;
    try {
      buf = bs58.decode(ix.data);
    } catch {
      continue;
    }
    if (buf.length < 8) continue;
    let discOk = true;
    for (let i = 0; i < 8; i++) {
      if (buf[i] !== SWAP_IX_DISC[i]) {
        discOk = false;
        break;
      }
    }
    if (!discOk) continue;

    const acc = ix.accounts;
    if (acc.length < 10) continue;
    const tokenIn = acc[7].toBase58();
    const tokenOut = acc[8].toBase58();
    const userB58 = acc[9].toBase58();

    if (tokenIn === WSOL_B58 && tokenOut === projectMintB58) {
      return { userB58, side: "buy" };
    }
    if (tokenIn === projectMintB58 && tokenOut === WSOL_B58) {
      return { userB58, side: "sell" };
    }
  }
  return null;
}

function gammPoolIsUsable(b58: string | null | undefined): boolean {
  if (b58 == null || b58.trim() === "") return false;
  try {
    const pk = new PublicKey(b58);
    return !pk.equals(PublicKey.default);
  } catch {
    return false;
  }
}

export type OmnipairIndexerRunResult = {
  tokensScanned: number;
  signaturesFetched: number;
  swapsIndexed: number;
  skippedNonSwap: number;
  skippedNoFill: number;
  errors: string[];
};

export type RunOmnipairIndexerOptions = {
  /** Max signatures to pull per pair (newest first). Default 40. */
  limitPerPair?: number;
  /** Known signatures to skip (local + Supabase). */
  knownSignatures?: Set<string>;
  /** Soft deadline — stop parsing once exceeded (ms since epoch). */
  deadlineMs?: number;
  /** Persist via upsertCanonicalTrade (default true). */
  persist?: boolean;
};

export type IndexMintResult = {
  mint: string;
  gammPool: string | null;
  signaturesFetched: number;
  swapsIndexed: number;
  skippedNonSwap: number;
  skippedNoFill: number;
  errors: string[];
  /** Parsed rows for this run (also returned when disk/Supabase are unavailable). */
  trades: CanonicalTradeRow[];
};

/**
 * Resolve graduated mint → Omnipair pair from on-chain `token_state`.
 */
export async function resolveOmnipairPairForMint(
  connection: Connection,
  mintB58: string
): Promise<{ mint: string; gammPool: string } | null> {
  let mintPk: PublicKey;
  try {
    mintPk = new PublicKey(mintB58);
  } catch {
    return null;
  }
  const [pda] = getTokenStatePDA(mintPk);
  const ro = getReadOnlyProgram(connection);
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const state = await (ro.account as any).tokenState.fetch(pda);
    const phase = chainPhaseLabelFromTokenState(state);
    if (phase !== "graduated") return null;
    const gamm = state.gammPool as PublicKey;
    if (!gamm || gamm.equals(PublicKey.default)) return null;
    return { mint: mintPk.toBase58(), gammPool: gamm.toBase58() };
  } catch {
    return null;
  }
}

/**
 * Index Omnipair swaps for one mint by scanning `getSignaturesForAddress(gamm_pool)`.
 * Batches `getParsedTransactions` and parses fills in-process (no re-fetch).
 * Always returns `trades` in-memory so serverless hosts without durable disk/Supabase still work.
 */
export async function indexOmnipairSwapsForMint(
  connection: Connection,
  mintB58: string,
  options: RunOmnipairIndexerOptions & { gammPool?: string } = {}
): Promise<IndexMintResult> {
  const limitPerPair = options.limitPerPair ?? 40;
  const persist = options.persist !== false;
  const deadlineMs = options.deadlineMs ?? 0;
  const result: IndexMintResult = {
    mint: mintB58,
    gammPool: null,
    signaturesFetched: 0,
    swapsIndexed: 0,
    skippedNonSwap: 0,
    skippedNoFill: 0,
    errors: [],
    trades: [],
  };

  let pairB58 = options.gammPool?.trim() ?? "";
  if (!gammPoolIsUsable(pairB58)) {
    const resolved = await resolveOmnipairPairForMint(connection, mintB58);
    if (!resolved) {
      return result;
    }
    pairB58 = resolved.gammPool;
    mintB58 = resolved.mint;
    result.mint = mintB58;
  }
  result.gammPool = pairB58;

  let pairPk: PublicKey;
  let projectMint: PublicKey;
  try {
    pairPk = new PublicKey(pairB58);
    projectMint = new PublicKey(mintB58);
  } catch (e) {
    result.errors.push(`bad pubkey mint=${mintB58}: ${String(e)}`);
    return result;
  }

  const known =
    options.knownSignatures ??
    new Set(listLocalTrades(mintB58).map((t) => t.signature));

  let sigInfos: Awaited<ReturnType<Connection["getSignaturesForAddress"]>>;
  try {
    sigInfos = await connection.getSignaturesForAddress(pairPk, {
      limit: limitPerPair,
    });
  } catch (e) {
    result.errors.push(`getSignaturesForAddress pair=${pairB58}: ${String(e)}`);
    return result;
  }

  result.signaturesFetched = sigInfos.length;

  // Prefer unknown sigs first; still include known so response can rebuild from chain
  // when the journal is empty (Vercel ephemeral FS / dead Supabase).
  const ordered = [
    ...sigInfos.filter((s) => !known.has(s.signature)),
    ...sigInfos.filter((s) => known.has(s.signature)),
  ];
  const toFetch = ordered.map((s) => s.signature);
  if (toFetch.length === 0) return result;

  const BATCH = 25;
  for (let i = 0; i < toFetch.length; i += BATCH) {
    if (deadlineMs > 0 && Date.now() >= deadlineMs) break;
    const chunk = toFetch.slice(i, i + BATCH);
    let parsedList: (ParsedTransactionWithMeta | null)[];
    try {
      parsedList = await connection.getParsedTransactions(chunk, {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0,
      });
    } catch (e) {
      result.errors.push(`getParsedTransactions: ${String(e)}`);
      break;
    }

    for (let j = 0; j < chunk.length; j++) {
      if (deadlineMs > 0 && Date.now() >= deadlineMs) break;
      const signature = chunk[j]!;
      const parsed = parsedList[j];
      if (!parsed?.meta || parsed.meta.err) continue;

      const swapMeta = parseOmnipairSwapMetaFromTx(
        parsed,
        OMNIPAIR_PROGRAM_ID,
        mintB58
      );
      if (!swapMeta) {
        result.skippedNonSwap += 1;
        continue;
      }

      const fill = omnipairSwapFillFromParsedTx(
        parsed,
        new PublicKey(swapMeta.userB58),
        projectMint
      );
      if (!fill) {
        result.skippedNoFill += 1;
        continue;
      }

      const tradeRow: CanonicalTradeRow = {
        mint: mintB58,
        signature,
        side: swapMeta.side,
        sol_amount_raw: fill.sol_amount_raw,
        token_amount_raw: fill.token_amount_raw,
        timestamp: fill.timestamp,
        wallet: swapMeta.userB58,
        price_sol: fill.price_sol,
        source: "omnipair",
      };

      result.trades.push(tradeRow);
      result.swapsIndexed += 1;
      known.add(signature);

      if (persist) {
        const up = await upsertCanonicalTrade(tradeRow);
        if (!up.ok) {
          result.errors.push(`upsert ${signature}: ${up.error}`);
        }
      }
    }
  }

  return result;
}

/**
 * MVP: poll `getSignaturesForAddress(pair)` for each graduated token with a real `gamm_pool`,
 * parse Omnipair `swap` instructions, derive fills from on-chain meta, upsert `trades` with
 * `source = 'omnipair'`. Idempotent on `signature` (matches client POST /api/trades).
 */
export async function runOmnipairSwapIndexer(
  connection: Connection,
  options: RunOmnipairIndexerOptions = {}
): Promise<OmnipairIndexerRunResult> {
  const limitPerPair = options.limitPerPair ?? 40;
  const result: OmnipairIndexerRunResult = {
    tokensScanned: 0,
    signaturesFetched: 0,
    swapsIndexed: 0,
    skippedNonSwap: 0,
    skippedNoFill: 0,
    errors: [],
  };

  let graduatedPairs: { mint: string; gammPool: string }[];
  try {
    graduatedPairs = await fetchGraduatedOmnipairMintsFromChain(connection);
  } catch (e) {
    result.errors.push(`chain tokenState scan: ${String(e)}`);
    return result;
  }

  for (const row of graduatedPairs) {
    result.tokensScanned += 1;
    const per = await indexOmnipairSwapsForMint(connection, row.mint, {
      limitPerPair,
      gammPool: row.gammPool,
      knownSignatures: options.knownSignatures,
    });
    result.signaturesFetched += per.signaturesFetched;
    result.swapsIndexed += per.swapsIndexed;
    result.skippedNonSwap += per.skippedNonSwap;
    result.skippedNoFill += per.skippedNoFill;
    result.errors.push(...per.errors);
  }

  return result;
}

export function getIndexerRpcConnection(): Connection {
  const url =
    process.env.SOLANA_RPC_URL ||
    process.env.NEXT_PUBLIC_SOLANA_RPC_URL ||
    "https://api.devnet.solana.com";
  return new Connection(url, "confirmed");
}
