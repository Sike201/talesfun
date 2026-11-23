import { Connection } from "@solana/web3.js";
import { getCachedSplMintHolders } from "../src/lib/tokenHolders";
import {
  getReadOnlyProgram,
  getTokenStatePDA,
  tokenStateToToken,
} from "../src/lib/program";
import { PublicKey } from "@solana/web3.js";

async function main() {
  const mint = process.argv[2];
  if (!mint) throw new Error("mint required");
  const c = new Connection(
    process.env.NEXT_PUBLIC_SOLANA_RPC_URL || "https://api.devnet.solana.com",
    "confirmed"
  );
  const program = getReadOnlyProgram(c);
  const [pda] = getTokenStatePDA(new PublicKey(mint));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const state = await (program.account as any).tokenState.fetch(pda).catch(() => null);
  const token = state ? tokenStateToToken(state, mint) : null;
  const exclude = token?.gammPool ? [token.gammPool] : [];
  const all = await getCachedSplMintHolders(c, mint, { decimals: 6, limit: 20 });
  const h = await getCachedSplMintHolders(c, mint, {
    decimals: 6,
    limit: 20,
    excludeOwners: exclude,
  });
  console.log({
    gammPool: token?.gammPool ?? null,
    rawOwners: all.length,
    holdersExcludingPool: h.length,
    top: h.slice(0, 8).map((x) => ({
      owner: x.owner,
      ui: Number(x.uiAmount.toFixed(2)),
    })),
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
