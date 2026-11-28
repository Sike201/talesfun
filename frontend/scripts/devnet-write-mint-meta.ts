import fs from "fs";
import path from "path";
import { Connection, Keypair, PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import {
  getReadOnlyProgram,
  getTokenStatePDA,
  tokenStateToToken,
} from "../src/lib/program";

async function main() {
  const mintStr =
    process.argv[2] ||
    (JSON.parse(fs.readFileSync(".e2e-tmp/talesfun-test-mint.json", "utf8"))
      .mint as string);
  const c = new Connection(
    process.env.NEXT_PUBLIC_SOLANA_RPC_URL || "https://api.devnet.solana.com",
    "confirmed"
  );
  const mint = new PublicKey(mintStr);
  const [pda] = getTokenStatePDA(mint);
  const program = getReadOnlyProgram(c);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const state = await (program.account as any).tokenState.fetch(pda);
  const t = tokenStateToToken(state, mintStr);
  console.log({
    phase: t.phase,
    gammPool: t.gammPool,
    supply: t.totalSupply,
    solRaised: t.solRaised,
  });
  if (!t.gammPool) throw new Error("missing gamm pool");

  const meta = {
    mint: mintStr,
    name: t.name || "talesfun test",
    ticker: t.ticker || "TALESFUN",
    imageUrl:
      "https://gateway.pinata.cloud/ipfs/QmUSWd6KNDYYPnMqRvgK5eNSSNdXDiRnRnWVkHXbLXTzyG",
    gammPool: t.gammPool,
    phase: t.phase,
    page: `http://localhost:3000/token/${mintStr}`,
    startedAt: new Date().toISOString(),
  };
  fs.writeFileSync(
    ".e2e-tmp/talesfun-test-mint.json",
    JSON.stringify(meta, null, 2)
  );
  console.log("saved", meta);

  const ph = Keypair.fromSecretKey(
    Uint8Array.from(
      JSON.parse(
        fs.readFileSync(
          path.join(process.env.HOME!, ".config/solana/phantom.json"),
          "utf8"
        )
      )
    )
  );
  const id = Keypair.fromSecretKey(
    Uint8Array.from(
      JSON.parse(
        fs.readFileSync(
          path.join(process.env.HOME!, ".config/solana/id.json"),
          "utf8"
        )
      )
    )
  );
  console.log("phantom", (await c.getBalance(ph.publicKey)) / LAMPORTS_PER_SOL);
  console.log("id", (await c.getBalance(id.publicKey)) / LAMPORTS_PER_SOL);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
