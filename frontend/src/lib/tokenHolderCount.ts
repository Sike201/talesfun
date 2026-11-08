import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { Connection, PublicKey } from "@solana/web3.js";
import type { ParsedAccountData } from "@solana/web3.js";

/** Classic SPL token account size (no extensions). */
const SPL_TOKEN_ACCOUNT_DATA_SIZE = 165;

/** Cache TTL — stay within ~30–60s window. */
const HOLDER_COUNT_TTL_MS = 45_000;

type CacheEntry = { value: number; expiresAt: number };

const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<number>>();

/**
 * Count distinct wallet owners with strictly positive raw token balance for `mint`.
 * Uses the same RPC as `Connection` (e.g. Helius via `NEXT_PUBLIC_SOLANA_RPC_URL`).
 */
export async function fetchSplMintHolderCount(
  connection: Connection,
  mintStr: string
): Promise<number> {
  const mint = new PublicKey(mintStr);
  const accounts = await connection.getParsedProgramAccounts(TOKEN_PROGRAM_ID, {
    filters: [
      { dataSize: SPL_TOKEN_ACCOUNT_DATA_SIZE },
      { memcmp: { offset: 0, bytes: mint.toBase58() } },
    ],
    commitment: "confirmed",
  });

  const ownersWithBalance = new Set<string>();
  for (const { account } of accounts) {
    const data = account.data as ParsedAccountData;
    if (data?.parsed?.type !== "account") continue;
    const info = data.parsed.info as {
      owner?: string;
      tokenAmount?: { amount?: string };
    };
    const raw = info?.tokenAmount?.amount;
    if (raw === undefined || raw === "0") continue;
    try {
      if (BigInt(raw) <= BigInt(0)) continue;
    } catch {
      continue;
    }
    const owner = info?.owner;
    if (typeof owner === "string" && owner.length > 0) {
      ownersWithBalance.add(owner);
    }
  }
  return ownersWithBalance.size;
}

export async function getCachedSplMintHolderCount(
  connection: Connection,
  mintStr: string
): Promise<number> {
  const now = Date.now();
  const hit = cache.get(mintStr);
  if (hit && hit.expiresAt > now) {
    return hit.value;
  }

  const pending = inflight.get(mintStr);
  if (pending) return pending;

  const promise = fetchSplMintHolderCount(connection, mintStr)
    .then((value) => {
      cache.set(mintStr, { value, expiresAt: Date.now() + HOLDER_COUNT_TTL_MS });
      return value;
    })
    .finally(() => {
      inflight.delete(mintStr);
    });

  inflight.set(mintStr, promise);
  return promise;
}
