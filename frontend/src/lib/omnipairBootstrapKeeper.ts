/**
 * Server-side Omnipair bootstrap automation (keeper).
 *
 * **Requires a protocol-funded keypair** (`OMNIPAIR_BOOTSTRAP_KEEPER_KEYPAIR_JSON`): this wallet is the
 * Omnipair `deployer` (pays ~0.2 SOL pair fee + rent), receives initial LP to its LP ATA, and must be
 * the **ALT authority** for `readBootstrapAltAddress()` / `NEXT_PUBLIC_OMNIPAIR_BOOTSTRAP_ALT` if the
 * bootstrap path uses that lookup table. It is **not** the project creator; vault liquidity still moves
 * from launchpad PDAs into this deployer’s WSOL/project ATAs during `bootstrap_omnipair_pool`.
 *
 * Burn / treasury: unchanged from on-chain launchpad; excess tokens are burned from `token_vault` there.
 */
import { Connection, Keypair, PublicKey, Transaction, VersionedTransaction } from "@solana/web3.js";
import type { AnchorWallet } from "@solana/wallet-adapter-react";
import {
  chainPhaseLabelFromTokenState,
  fetchMintRecordsNeedingOmnipairBootstrap,
  getReadOnlyProgram,
  getTokenStatePDA,
} from "@/lib/program";
import { sendBootstrapOmnipairPoolTx } from "@/lib/omnipairBootstrap";

/** JSON array of 64 secret key bytes (same format as Solana CLI keypair export). */
export function loadBootstrapKeeperKeypair(): Keypair | null {
  const json = process.env.OMNIPAIR_BOOTSTRAP_KEEPER_KEYPAIR_JSON?.trim();
  if (!json) return null;
  try {
    const arr = JSON.parse(json) as number[];
    if (!Array.isArray(arr) || arr.length < 64) return null;
    return Keypair.fromSecretKey(Uint8Array.from(arr));
  } catch {
    return null;
  }
}

export function keeperKeypairToAnchorWallet(kp: Keypair): AnchorWallet {
  return {
    publicKey: kp.publicKey,
    signTransaction: async <T extends Transaction | VersionedTransaction>(tx: T) => {
      if (tx instanceof VersionedTransaction) {
        tx.sign([kp]);
        return tx;
      }
      (tx as Transaction).partialSign(kp);
      return tx;
    },
    signAllTransactions: async <T extends Transaction | VersionedTransaction>(txs: T[]) => {
      for (const t of txs) {
        if (t instanceof VersionedTransaction) {
          t.sign([kp]);
        } else {
          t.partialSign(kp);
        }
      }
      return txs;
    },
  } as AnchorWallet;
}

export async function tokenNeedsOmnipairBootstrap(
  connection: Connection,
  mint: PublicKey
): Promise<boolean> {
  const program = getReadOnlyProgram(connection);
  const [pda] = getTokenStatePDA(mint);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const state = await (program.account as any).tokenState.fetch(pda);
  if (chainPhaseLabelFromTokenState(state) !== "graduated") {
    return false;
  }
  const gamm = state.gammPool as PublicKey;
  return gamm.equals(PublicKey.default);
}

export type OmnipairBootstrapKeeperResult = {
  scanned: number;
  attempted: number;
  succeeded: { mint: string; signature: string }[];
  failed: { mint: string; error: string }[];
  skipped: string[];
};

function defaultLpUriBase(): string {
  const u =
    process.env.NEXT_PUBLIC_BASE_URL?.replace(/\/$/, "") ||
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "") ||
    "https://higher.run";
  return u;
}

/**
 * Scans **on-chain** `token_state` (graduated + default `gamm_pool`), runs
 * `sendBootstrapOmnipairPoolTx` for up to `maxMints` tokens. Does not use Supabase
 * for candidate selection.
 */
export async function runOmnipairBootstrapKeeperCycle(options?: {
  maxMints?: number;
}): Promise<OmnipairBootstrapKeeperResult> {
  const kp = loadBootstrapKeeperKeypair();
  if (!kp) {
    throw new Error("OMNIPAIR_BOOTSTRAP_KEEPER_KEYPAIR_JSON is not set or invalid");
  }

  const rpc =
    process.env.SOLANA_RPC_URL ||
    process.env.NEXT_PUBLIC_SOLANA_RPC_URL ||
    "https://api.devnet.solana.com";
  const connection = new Connection(rpc, "confirmed");
  const wallet = keeperKeypairToAnchorWallet(kp);
  const maxMints = options?.maxMints ?? 5;

  const candidates = await fetchMintRecordsNeedingOmnipairBootstrap(connection);

  const result: OmnipairBootstrapKeeperResult = {
    scanned: 0,
    attempted: 0,
    succeeded: [],
    failed: [],
    skipped: [],
  };

  const base = defaultLpUriBase();

  for (const row of candidates) {
    if (result.attempted >= maxMints) break;

    const mintStr = row.mint;
    let mint: PublicKey;
    try {
      mint = new PublicKey(mintStr);
    } catch {
      continue;
    }

    result.scanned += 1;

    const needs = await tokenNeedsOmnipairBootstrap(connection, mint);
    if (!needs) {
      result.skipped.push(mintStr);
      continue;
    }

    result.attempted += 1;
    const sym = row.symbol.trim();
    const ticker = sym ? sym.replace(/[^a-zA-Z0-9]/g, "").slice(0, 10) || "TKN" : "TKN";
    const lpUri = `${base}/metadata/omnipair-lp?mint=${encodeURIComponent(mintStr)}`;

    try {
      console.info("[omnipair keeper] bootstrapping", { mint: mintStr, ticker, deployer: kp.publicKey.toBase58() });
      const sig = await sendBootstrapOmnipairPoolTx({
        connection,
        wallet,
        mint,
        ticker,
        lpUri,
      });
      result.succeeded.push({ mint: mintStr, signature: sig });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn("[omnipair keeper] bootstrap failed", { mint: mintStr, error: msg });
      result.failed.push({ mint: mintStr, error: msg });
    }
  }

  return result;
}
