import type { Connection } from "@solana/web3.js";
import { fetchSplMintHolders } from "@/lib/tokenHolders";

/** Cache TTL — stay within ~30–60s window. */
const HOLDER_COUNT_TTL_MS = 45_000;

type CacheEntry = { value: number; expiresAt: number };

const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<number>>();

/**
 * Count distinct wallet owners with positive balance, excluding pool / burn sinks.
 * Same source as the Holders list so the badge and table never disagree.
 */
export async function fetchSplMintHolderCount(
  connection: Connection,
  mintStr: string,
  opts?: { excludeOwners?: string[] }
): Promise<number> {
  const holders = await fetchSplMintHolders(connection, mintStr, {
    decimals: 6,
    limit: 500,
    excludeOwners: opts?.excludeOwners,
  });
  return holders.length;
}

export async function getCachedSplMintHolderCount(
  connection: Connection,
  mintStr: string,
  opts?: { excludeOwners?: string[] }
): Promise<number> {
  const key = `${mintStr}:${(opts?.excludeOwners ?? []).join(",")}`;
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && hit.expiresAt > now) {
    return hit.value;
  }

  const pending = inflight.get(key);
  if (pending) return pending;

  const promise = fetchSplMintHolderCount(connection, mintStr, opts)
    .then((value) => {
      cache.set(key, { value, expiresAt: Date.now() + HOLDER_COUNT_TTL_MS });
      return value;
    })
    .finally(() => {
      inflight.delete(key);
    });

  inflight.set(key, promise);
  return promise;
}
