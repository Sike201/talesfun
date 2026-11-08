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
import { fetchGraduatedOmnipairMintsFromChain } from "@/lib/program";
import { supabaseAdmin } from "@/lib/supabase-server";
import { fetchOmnipairSwapFillFromTx } from "@/lib/omnipairSwap";
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
};

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
    const mintB58 = row.mint;
    result.tokensScanned += 1;

    const pairB58 = row.gammPool.trim();
    if (!gammPoolIsUsable(pairB58)) {
      continue;
    }

    let pairPk: PublicKey;
    let projectMint: PublicKey;
    try {
      pairPk = new PublicKey(pairB58);
      projectMint = new PublicKey(mintB58);
    } catch (e) {
      result.errors.push(`bad pubkey mint=${mintB58}: ${String(e)}`);
      continue;
    }

    let sigInfos: Awaited<
      ReturnType<Connection["getSignaturesForAddress"]>
    >;
    try {
      sigInfos = await connection.getSignaturesForAddress(pairPk, {
        limit: limitPerPair,
      });
    } catch (e) {
      result.errors.push(
        `getSignaturesForAddress pair=${pairB58}: ${String(e)}`
      );
      continue;
    }

    result.signaturesFetched += sigInfos.length;

    for (const info of sigInfos) {
      const { signature } = info;

      const { data: existing } = await supabaseAdmin
        .from("trades")
        .select("signature")
        .eq("signature", signature)
        .maybeSingle();

      if (existing) {
        break;
      }

      let parsed: ParsedTransactionWithMeta | null;
      try {
        parsed = await connection.getParsedTransaction(signature, {
          commitment: "confirmed",
          maxSupportedTransactionVersion: 0,
        });
      } catch (e) {
        result.errors.push(`getParsedTransaction ${signature}: ${String(e)}`);
        continue;
      }

      if (!parsed?.meta || parsed.meta.err) {
        continue;
      }

      const swapMeta = parseOmnipairSwapMetaFromTx(
        parsed,
        OMNIPAIR_PROGRAM_ID,
        mintB58
      );
      if (!swapMeta) {
        result.skippedNonSwap += 1;
        continue;
      }

      const fill = await fetchOmnipairSwapFillFromTx(
        connection,
        signature,
        new PublicKey(swapMeta.userB58),
        projectMint
      );
      if (!fill) {
        result.skippedNoFill += 1;
        console.warn("[omnipair:indexer] swap without parseable token balances", {
          signature,
          mint: mintB58,
        });
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

      const up = await upsertCanonicalTrade(tradeRow);
      if (!up.ok) {
        result.errors.push(`upsert ${signature}: ${up.error}`);
        continue;
      }

      result.swapsIndexed += 1;
      console.info("[omnipair:indexer] indexed swap", {
        mint: mintB58,
        signature,
        side: swapMeta.side,
      });
    }
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
