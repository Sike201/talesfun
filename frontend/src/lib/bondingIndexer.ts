import bs58 from "bs58";
import {
  Connection,
  PublicKey,
  type ParsedTransactionWithMeta,
  type PartiallyDecodedInstruction,
  type ParsedInstruction,
} from "@solana/web3.js";
import {
  getSolVaultPDA,
  getTokenStatePDA,
  PROGRAM_ID,
} from "@/lib/program";
import {
  upsertCanonicalTrade,
  type CanonicalTradeRow,
} from "@/lib/persistCanonicalTrade";

/** Anchor `global:buy` / `global:sell` discriminators. */
const BUY_DISC = Uint8Array.from([102, 6, 61, 18, 1, 218, 235, 234]);
const SELL_DISC = Uint8Array.from([51, 230, 133, 164, 1, 127, 131, 173]);

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
  for (const group of tx.meta?.innerInstructions ?? []) {
    for (const ix of group.instructions) {
      yield ix;
    }
  }
}

function discMatch(buf: Uint8Array, disc: Uint8Array): boolean {
  if (buf.length < 8) return false;
  for (let i = 0; i < 8; i++) {
    if (buf[i] !== disc[i]) return false;
  }
  return true;
}

function readU64Le(buf: Uint8Array, offset: number): bigint | null {
  if (buf.length < offset + 8) return null;
  const view = new DataView(buf.buffer, buf.byteOffset + offset, 8);
  const lo = view.getUint32(0, true);
  const hi = view.getUint32(4, true);
  return (BigInt(hi) << BigInt(32)) | BigInt(lo);
}

function lamportsDeltaForAccount(
  tx: ParsedTransactionWithMeta,
  accountB58: string
): bigint {
  const keys = tx.transaction.message.accountKeys.map(k =>
    typeof k === "string"
      ? k
      : (k as { pubkey: PublicKey }).pubkey.toBase58()
  );
  const idx = keys.indexOf(accountB58);
  if (idx < 0) return BigInt(0);
  const pre = BigInt(tx.meta?.preBalances?.[idx] ?? 0);
  const post = BigInt(tx.meta?.postBalances?.[idx] ?? 0);
  return post - pre;
}

function tokenDeltaRaw(
  tx: ParsedTransactionWithMeta,
  mintB58: string,
  ownerB58: string
): bigint {
  const pre = tx.meta?.preTokenBalances ?? [];
  const post = tx.meta?.postTokenBalances ?? [];
  const preAmt = pre.find(
    b => b.mint === mintB58 && b.owner === ownerB58
  )?.uiTokenAmount?.amount;
  const postAmt = post.find(
    b => b.mint === mintB58 && b.owner === ownerB58
  )?.uiTokenAmount?.amount;
  try {
    return BigInt(postAmt || "0") - BigInt(preAmt || "0");
  } catch {
    return BigInt(0);
  }
}

export type BondingIndexedTrade = CanonicalTradeRow & {
  source: "bonding";
};

/**
 * Parse a higher-launchpad buy/sell from a confirmed tx.
 * Account layout: [token_state, mint, sol_vault, token_vault, user_ata, user, ...]
 */
export function parseBondingTradeFromTx(
  tx: ParsedTransactionWithMeta,
  programId: PublicKey,
  mintB58: string
): Omit<BondingIndexedTrade, "signature" | "timestamp"> | null {
  for (const ix of iterAllInstructions(tx)) {
    if (!isPartiallyDecoded(ix)) continue;
    if (!ix.programId.equals(programId)) continue;
    let buf: Uint8Array;
    try {
      buf = bs58.decode(ix.data);
    } catch {
      continue;
    }
    const isBuy = discMatch(buf, BUY_DISC);
    const isSell = discMatch(buf, SELL_DISC);
    if (!isBuy && !isSell) continue;

    const accounts = ix.accounts;
    if (accounts.length < 6) continue;
    const mintAcc = accounts[1]!.toBase58();
    if (mintAcc !== mintB58) continue;

    const solVault = accounts[2]!.toBase58();
    const user = accounts[5]!.toBase58();
    const arg0 = readU64Le(buf, 8);

    let solRaw = BigInt(0);
    let tokenRaw = BigInt(0);
    const side: "buy" | "sell" = isBuy ? "buy" : "sell";

    if (isBuy) {
      solRaw = arg0 ?? BigInt(0);
      const tokDelta = tokenDeltaRaw(tx, mintB58, user);
      tokenRaw = tokDelta > BigInt(0) ? tokDelta : BigInt(0);
      if (solRaw === BigInt(0)) {
        const vaultGain = lamportsDeltaForAccount(tx, solVault);
        if (vaultGain > BigInt(0)) solRaw = vaultGain;
      }
    } else {
      tokenRaw = arg0 ?? BigInt(0);
      const vaultLoss = -lamportsDeltaForAccount(tx, solVault);
      solRaw = vaultLoss > BigInt(0) ? vaultLoss : BigInt(0);
      if (tokenRaw === BigInt(0)) {
        const tokDelta = -tokenDeltaRaw(tx, mintB58, user);
        if (tokDelta > BigInt(0)) tokenRaw = tokDelta;
      }
    }

    if (solRaw <= BigInt(0) && tokenRaw <= BigInt(0)) continue;

    const solUi = Number(solRaw) / 1e9;
    const tokUi = Number(tokenRaw) / 1e6;
    const price_sol =
      tokUi > 0 && Number.isFinite(solUi / tokUi) ? solUi / tokUi : 0;

    return {
      mint: mintB58,
      side,
      wallet: user,
      sol_amount_raw: solRaw.toString(),
      token_amount_raw: tokenRaw.toString(),
      price_sol,
      source: "bonding",
    };
  }
  return null;
}

export type IndexBondingResult = {
  mint: string;
  solVault: string;
  signaturesFetched: number;
  tradesIndexed: number;
  trades: BondingIndexedTrade[];
};

/**
 * Index bonding-curve buy/sell by scanning `sol_vault` signatures for a mint.
 * Works for live bonding markets and historical fills after graduation.
 */
export async function indexBondingTradesForMint(
  connection: Connection,
  mintAddress: string,
  options?: {
    limit?: number;
    knownSignatures?: Set<string>;
    deadlineMs?: number;
    persist?: boolean;
  }
): Promise<IndexBondingResult> {
  const mintPk = new PublicKey(mintAddress);
  const [solVault] = getSolVaultPDA(mintPk);
  const [tokenState] = getTokenStatePDA(mintPk);
  const limit = Math.min(200, Math.max(20, options?.limit ?? 80));
  const known = options?.knownSignatures ?? new Set<string>();
  const deadline = options?.deadlineMs ?? Date.now() + 18_000;
  const persist = options?.persist !== false;

  const result: IndexBondingResult = {
    mint: mintAddress,
    solVault: solVault.toBase58(),
    signaturesFetched: 0,
    tradesIndexed: 0,
    trades: [],
  };

  let sigInfos: Awaited<ReturnType<Connection["getSignaturesForAddress"]>>;
  try {
    // Prefer sol_vault (moves on every buy/sell); fall back to token_state.
    sigInfos = await connection.getSignaturesForAddress(solVault, {
      limit,
    });
    if (sigInfos.length === 0) {
      sigInfos = await connection.getSignaturesForAddress(tokenState, {
        limit,
      });
    }
  } catch (e) {
    console.warn("[bonding-indexer] getSignatures failed", mintAddress, e);
    return result;
  }

  result.signaturesFetched = sigInfos.length;
  const programId = PROGRAM_ID;

  for (const info of sigInfos) {
    if (Date.now() > deadline) break;
    if (known.has(info.signature)) continue;
    if (info.err) continue;

    let tx: ParsedTransactionWithMeta | null;
    try {
      tx = await connection.getParsedTransaction(info.signature, {
        maxSupportedTransactionVersion: 0,
        commitment: "confirmed",
      });
    } catch {
      continue;
    }
    if (!tx?.meta || tx.meta.err) continue;

    const parsed = parseBondingTradeFromTx(tx, programId, mintAddress);
    if (!parsed) continue;

    const blockTime = info.blockTime ?? tx.blockTime;
    const timestamp = new Date(
      (blockTime ?? Math.floor(Date.now() / 1000)) * 1000
    ).toISOString();

    const row: BondingIndexedTrade = {
      ...parsed,
      signature: info.signature,
      timestamp,
    };
    result.trades.push(row);
    result.tradesIndexed++;

    if (persist) {
      try {
        await upsertCanonicalTrade(row);
      } catch (e) {
        console.warn(
          "[bonding-indexer] persist failed",
          info.signature.slice(0, 12),
          e
        );
      }
    }
  }

  return result;
}
