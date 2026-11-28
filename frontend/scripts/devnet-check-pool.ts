import fs from "fs";
import { Connection, PublicKey } from "@solana/web3.js";
import { fetchOmnipairPoolSnapshot } from "../src/lib/omnipairPoolState";

async function main() {
  const meta = JSON.parse(
    fs.readFileSync(".e2e-tmp/talesfun-test-mint.json", "utf8")
  ) as { mint: string; gammPool: string };
  const c = new Connection(process.env.NEXT_PUBLIC_SOLANA_RPC_URL!, "confirmed");
  const supply = await c.getTokenSupply(new PublicKey(meta.mint));
  const snap = await fetchOmnipairPoolSnapshot(
    c,
    meta.gammPool,
    meta.mint,
    null
  );
  console.log({
    mint: meta.mint,
    mintSupplyUi: supply.value.uiAmount,
    poolOk: snap.ok,
    ...(snap.ok
      ? {
          poolSol: Number(snap.data.reserveSolRaw) / 1e9,
          poolTok:
            Number(snap.data.reserveProjectRaw) /
            10 ** snap.data.projectTokenDecimals,
          spot: snap.data.spotPriceSol,
        }
      : { err: (snap as { message: string }).message }),
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
