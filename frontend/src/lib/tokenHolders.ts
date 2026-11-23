import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { Connection, PublicKey } from "@solana/web3.js";
import type { ParsedAccountData } from "@solana/web3.js";

const SPL_TOKEN_ACCOUNT_DATA_SIZE = 165;
const HOLDERS_TTL_MS = 45_000;

export type MintHolder = {
  owner: string;
  amountRaw: string;
  uiAmount: number;
};

type CacheEntry = { value: MintHolder[]; expiresAt: number };

const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<MintHolder[]>>();

/**
 * Distinct wallet owners with positive balance for `mint`, sorted by size desc.
 * Excludes the incinerator sink used for locked LP.
 */
export async function fetchSplMintHolders(
  connection: Connection,
  mintStr: string,
  opts?: { decimals?: number; limit?: number; excludeOwners?: string[] }
): Promise<MintHolder[]> {
  const mint = new PublicKey(mintStr);
  const decimals = opts?.decimals ?? 6;
  const limit = opts?.limit ?? 50;
  const exclude = new Set(
    (opts?.excludeOwners ?? []).filter((x) => typeof x === "string" && x.length > 0)
  );
  const accounts = await connection.getParsedProgramAccounts(TOKEN_PROGRAM_ID, {
    filters: [
      { dataSize: SPL_TOKEN_ACCOUNT_DATA_SIZE },
      { memcmp: { offset: 0, bytes: mint.toBase58() } },
    ],
    commitment: "confirmed",
  });

  const byOwner = new Map<string, bigint>();
  for (const { account } of accounts) {
    const data = account.data as ParsedAccountData;
    if (data?.parsed?.type !== "account") continue;
    const info = data.parsed.info as {
      owner?: string;
      tokenAmount?: { amount?: string };
    };
    const raw = info?.tokenAmount?.amount;
    if (raw === undefined || raw === "0") continue;
    let amt: bigint;
    try {
      amt = BigInt(raw);
    } catch {
      continue;
    }
    if (amt <= 0n) continue;
    const owner = info?.owner;
    if (typeof owner !== "string" || !owner) continue;
    // Skip burn sinks + pool / protocol accounts
    if (owner.startsWith("1nc1nerator")) continue;
    if (exclude.has(owner)) continue;
    byOwner.set(owner, (byOwner.get(owner) ?? 0n) + amt);
  }

  const rows: MintHolder[] = [...byOwner.entries()]
    .map(([owner, amountRaw]) => ({
      owner,
      amountRaw: amountRaw.toString(),
      uiAmount: Number(amountRaw) / 10 ** decimals,
    }))
    .sort((a, b) => b.uiAmount - a.uiAmount)
    .slice(0, limit);

  return rows;
}

export async function getCachedSplMintHolders(
  connection: Connection,
  mintStr: string,
  opts?: { decimals?: number; limit?: number; excludeOwners?: string[] }
): Promise<MintHolder[]> {
  const key = `${mintStr}:${opts?.decimals ?? 6}:${opts?.limit ?? 50}:${(opts?.excludeOwners ?? []).join(",")}`;
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && hit.expiresAt > now) return hit.value;

  const pending = inflight.get(key);
  if (pending) return pending;

  const promise = fetchSplMintHolders(connection, mintStr, opts)
    .then((value) => {
      cache.set(key, { value, expiresAt: Date.now() + HOLDERS_TTL_MS });
      return value;
    })
    .finally(() => {
      inflight.delete(key);
    });

  inflight.set(key, promise);
  return promise;
}
