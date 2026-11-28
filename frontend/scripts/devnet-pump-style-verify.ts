/**
 * After a graduated mint, print pump-style economics vs what we expect.
 *   npx tsx --env-file=.env.local scripts/devnet-pump-style-verify.ts [mint]
 */
import fs from "node:fs";
import path from "node:path";
import { Connection, PublicKey } from "@solana/web3.js";
import {
  getReadOnlyProgram,
  getTokenStatePDA,
  tokenStateToToken,
} from "../src/lib/program";
import { fetchOmnipairPoolSnapshot } from "../src/lib/omnipairPoolState";
import {
  graduatedLiquidityUsd,
  marketCapUsdFromSpot,
  mcapToLiquidityRatio,
  isThinLiquidity,
} from "../src/lib/marketStats";

const ROOT = path.resolve(__dirname, "..");
const META = path.join(ROOT, ".e2e-tmp/talesfun-test-mint.json");

async function solUsd(): Promise<number> {
  try {
    const r = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd");
    const j = (await r.json()) as { solana?: { usd?: number } };
    if (j.solana?.usd && j.solana.usd > 0) return j.solana.usd;
  } catch {
    /* fallback */
  }
  return 140;
}

async function main() {
  const mintStr =
    process.argv[2] ||
    (JSON.parse(fs.readFileSync(META, "utf8")) as { mint: string }).mint;
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
  if (!t.gammPool) throw new Error("no gamm pool — not bootstrapped?");

  const [supply, snap, usd] = await Promise.all([
    c.getTokenSupply(mint),
    fetchOmnipairPoolSnapshot(c, t.gammPool, mintStr, null),
    solUsd(),
  ]);
  if (!snap.ok) throw new Error(snap.message);

  const mintSupplyUi = supply.value.uiAmount ?? 0;
  const stateSupplyUi = t.totalSupply;
  const poolSol = Number(snap.data.reserveSolRaw) / 1e9;
  const poolTok =
    Number(snap.data.reserveProjectRaw) / 10 ** snap.data.projectTokenDecimals;
  const spot = snap.data.spotPriceSol;

  const mcapLive = marketCapUsdFromSpot({
    spotSol: spot,
    totalSupply: mintSupplyUi,
    solUsd: usd,
  });
  const mcapIf1B = marketCapUsdFromSpot({
    spotSol: spot,
    totalSupply: 1_000_000_000,
    solUsd: usd,
  });
  const liq = graduatedLiquidityUsd({ reserveSol: poolSol, solUsd: usd });
  const ratio = mcapToLiquidityRatio(mcapLive, liq);
  const ratio1B = mcapToLiquidityRatio(mcapIf1B, liq);

  // Pump at full 85 SOL graduation (reference)
  const pump = {
    poolSol: 85,
    poolTok: 206_900_000,
    mintSupply: 1_000_000_000,
    fdvSol: 410.9,
    liqSol: 170,
    mcapToLiq: 410.9 / 170,
  };

  const out = {
    mint: mintStr,
    phase: t.phase,
    gammPool: t.gammPool,
    solUsd: usd,
    graduationEnv: process.env.NEXT_PUBLIC_GRADUATION_SOL || "85",
    supply: {
      splMintUi: mintSupplyUi,
      tokenStateUi: stateSupplyUi,
      stale1B: stateSupplyUi >= 999_000_000,
      burnedApprox: Math.max(0, 1_000_000_000 - mintSupplyUi),
    },
    pool: {
      sol: poolSol,
      tokens: poolTok,
      spotSolPerToken: spot,
      tokensInPoolPctOfMint:
        mintSupplyUi > 0 ? (100 * poolTok) / mintSupplyUi : null,
    },
    statsLiveSupply: {
      mcapUsd: Math.round(mcapLive),
      liqUsd: Math.round(liq),
      mcapToLiq: ratio != null ? Number(ratio.toFixed(2)) : null,
      thinBadge: isThinLiquidity(mcapLive, liq),
      liqPctOfMcap:
        mcapLive > 0 ? Number(((100 * liq) / mcapLive).toFixed(1)) + "%" : null,
    },
    statsIfWrong1B: {
      mcapUsd: Math.round(mcapIf1B),
      mcapToLiq: ratio1B != null ? Number(ratio1B.toFixed(2)) : null,
      note: "what the buggy UI used to show",
    },
    pumpReferenceAt85: {
      poolSol: pump.poolSol,
      poolTok: pump.poolTok,
      mintSupply: pump.mintSupply,
      mcapToLiq: Number(pump.mcapToLiq.toFixed(2)),
      note: "Pump seeds ~206.9M + ~85 SOL, keeps 1B supply, FDV~411 SOL → ~2.4× mcap/liq",
    },
    page: `http://localhost:3000/token/${mintStr}`,
  };

  fs.writeFileSync(
    path.join(ROOT, ".e2e-tmp/pump-style-verify.json"),
    JSON.stringify(out, null, 2)
  );
  console.log(JSON.stringify(out, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
