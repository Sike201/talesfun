/**
 * Bootstrap Omnipair pool for a graduated mint.
 * Usage: npx tsx --env-file=.env.local scripts/devnet-bootstrap-mint.ts <mint>
 */
import fs from "node:fs";
import path from "node:path";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { sendBootstrapOmnipairPoolTx } from "../src/lib/omnipairBootstrap";
import {
  getReadOnlyProgram,
  getTokenStatePDA,
  tokenStateToToken,
} from "../src/lib/program";

async function main() {
  const mintStr = process.argv[2];
  if (!mintStr) throw new Error("Usage: … <mint>");
  const mint = new PublicKey(mintStr);
  const secret = JSON.parse(
    fs.readFileSync(
      path.join(process.env.HOME!, ".config/solana/id.json"),
      "utf8"
    )
  );
  const kp = Keypair.fromSecretKey(Uint8Array.from(secret));
  const connection = new Connection(
    process.env.NEXT_PUBLIC_SOLANA_RPC_URL || "https://api.devnet.solana.com",
    "confirmed"
  );
  const wallet = {
    publicKey: kp.publicKey,
    signTransaction: async <T extends { partialSign: (k: Keypair) => void }>(
      tx: T
    ) => {
      tx.partialSign(kp);
      return tx;
    },
    signAllTransactions: async <
      T extends { partialSign: (k: Keypair) => void },
    >(
      txs: T[]
    ) => {
      for (const tx of txs) tx.partialSign(kp);
      return txs;
    },
  };

  const bal = await connection.getBalance(kp.publicKey);
  console.log("deployer", kp.publicKey.toBase58(), "SOL", bal / 1e9);
  const feeBudget = Number(process.env.NEXT_PUBLIC_OMNIPAIR_PAIR_FEE_SOL || "0.25");
  if (bal < (feeBudget + 0.1) * 1e9) {
    throw new Error(`Need >= ${feeBudget + 0.1} SOL for Omnipair fee buffer + rent`);
  }

  const program = getReadOnlyProgram(connection);
  const [pda] = getTokenStatePDA(mint);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const state = await (program.account as any).tokenState.fetch(pda);
  const token = tokenStateToToken(state, mintStr);
  console.log("phase", token.phase, "gamm", token.gammPool || "(unset)");
  if (token.phase !== "graduated") throw new Error("token not graduated");
  if (token.gammPool) {
    console.log("already bootstrapped", token.gammPool);
    return;
  }

  const lpUri = `https://tales.fun/metadata/lp/${mint.toBase58()}.json`;
  const sig = await sendBootstrapOmnipairPoolTx({
    connection,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    wallet: wallet as any,
    mint,
    ticker: token.ticker || "TALE",
    lpUri,
    logAccountMetas: true,
  });
  console.log("BOOTSTRAP OK", sig);

  const state2 = await (program.account as any).tokenState.fetch(pda);
  const next = tokenStateToToken(state2, mintStr);
  console.log("gamm_pool", next.gammPool);
}

main().catch(e => {
  console.error("BOOTSTRAP FAIL", e);
  process.exit(1);
});
