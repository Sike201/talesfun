/**
 * Bootstrap Omnipair pool for a graduated mint.
 * Usage: npx tsx --env-file=.env.local scripts/devnet-bootstrap-mint.ts <mint>
 */
import fs from "node:fs";
import path from "node:path";
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  VersionedTransaction,
} from "@solana/web3.js";
import { sendBootstrapOmnipairPoolTx } from "../src/lib/omnipairBootstrap";
import {
  getReadOnlyProgram,
  getTokenStatePDA,
  tokenStateToToken,
} from "../src/lib/program";

function signWithKeeper<T extends Transaction | VersionedTransaction>(
  tx: T,
  kp: Keypair
): T {
  if (tx instanceof VersionedTransaction) {
    tx.sign([kp]);
    return tx;
  }
  tx.partialSign(kp);
  return tx;
}

async function main() {
  const mintStr = process.argv[2];
  if (!mintStr) throw new Error("Usage: … <mint>");
  const mint = new PublicKey(mintStr);

  // Prefer platform keeper so Dusk market operator = platform authority.
  const keeperJson = process.env.OMNIPAIR_BOOTSTRAP_KEEPER_KEYPAIR_JSON?.trim();
  const secret = keeperJson
    ? (JSON.parse(keeperJson) as number[])
    : (JSON.parse(
        fs.readFileSync(
          path.join(process.env.HOME!, ".config/solana/id.json"),
          "utf8"
        )
      ) as number[]);
  const kp = Keypair.fromSecretKey(Uint8Array.from(secret));
  const platform = process.env.NEXT_PUBLIC_PLATFORM_AUTHORITY?.trim();
  if (platform && kp.publicKey.toBase58() !== platform) {
    console.warn(
      "[bootstrap] signer is not NEXT_PUBLIC_PLATFORM_AUTHORITY — operator will not be platform",
      { signer: kp.publicKey.toBase58(), platform }
    );
  }

  const connection = new Connection(
    process.env.NEXT_PUBLIC_SOLANA_RPC_URL || "https://api.devnet.solana.com",
    "confirmed"
  );
  const wallet = {
    publicKey: kp.publicKey,
    signTransaction: async <T extends Transaction | VersionedTransaction>(
      tx: T
    ) => signWithKeeper(tx, kp),
    signAllTransactions: async <T extends Transaction | VersionedTransaction>(
      txs: T[]
    ) => txs.map((tx) => signWithKeeper(tx, kp)),
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
