import { Connection } from "@solana/web3.js";
import { getCachedSplMintHolders } from "../src/lib/tokenHolders";

async function main() {
  const mint = process.argv[2];
  if (!mint) throw new Error("mint required");
  const c = new Connection(
    process.env.NEXT_PUBLIC_SOLANA_RPC_URL || "https://api.devnet.solana.com",
    "confirmed"
  );
  const h = await getCachedSplMintHolders(c, mint, { decimals: 6, limit: 15 });
  console.log({
    holders: h.length,
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
