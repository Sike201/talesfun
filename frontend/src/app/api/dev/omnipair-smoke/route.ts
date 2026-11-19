import { NextRequest } from "next/server";
import { Connection, Keypair, PublicKey, Transaction } from "@solana/web3.js";
import { fetchOmnipairPoolSnapshot } from "@/lib/omnipairPoolState";
import { sendOmnipairSwapTx } from "@/lib/omnipairSwap";
import {
  getReadOnlyProgram,
  getTokenStatePDA,
  tokenStateToToken,
} from "@/lib/program";

export const dynamic = "force-dynamic";

function authorize(request: NextRequest): boolean {
  const secret = (
    process.env.CRON_SECRET ||
    process.env.OMNIPAIR_BOOTSTRAP_KEEPER_SECRET ||
    ""
  ).trim();
  if (!secret) return false;
  return (
    request.headers.get("authorization") === `Bearer ${secret}` ||
    request.headers.get("x-cron-secret") === secret
  );
}

function loadPayer(): Keypair {
  const json = process.env.OMNIPAIR_BOOTSTRAP_KEEPER_KEYPAIR_JSON?.trim();
  if (!json) throw new Error("OMNIPAIR_BOOTSTRAP_KEEPER_KEYPAIR_JSON missing");
  const arr = JSON.parse(json) as number[];
  return Keypair.fromSecretKey(Uint8Array.from(arr));
}

/**
 * Local smoke: verify pool snapshot + attempt a tiny Omnipair buy swap.
 * GET /api/dev/omnipair-smoke?mint=...
 */
export async function GET(request: NextRequest) {
  if (!authorize(request)) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const mintStr = request.nextUrl.searchParams.get("mint")?.trim();
  if (!mintStr) {
    return Response.json({ error: "mint required" }, { status: 400 });
  }

  const mint = new PublicKey(mintStr);
  const rpc =
    process.env.NEXT_PUBLIC_SOLANA_RPC_URL || "https://api.devnet.solana.com";
  const connection = new Connection(rpc, "confirmed");
  const program = getReadOnlyProgram(connection);
  const [pda] = getTokenStatePDA(mint);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const state = await (program.account as any).tokenState.fetch(pda);
  const token = tokenStateToToken(state, mintStr);

  if (!token.gammPool) {
    return Response.json(
      { ok: false, error: "gamm_pool unset", token },
      { status: 400 }
    );
  }

  const pair = new PublicKey(token.gammPool);
  const kp = loadPayer();
  const snapRes = await fetchOmnipairPoolSnapshot(
    connection,
    pair.toBase58(),
    mintStr,
    kp.publicKey
  );
  if (!snapRes.ok || !snapRes.data) {
    return Response.json(
      {
        ok: false,
        error: snapRes.ok === false ? snapRes.message : "no snapshot",
        pair: pair.toBase58(),
      },
      { status: 500 }
    );
  }
  const snapshot = snapRes.data;

  const doSwap = request.nextUrl.searchParams.get("swap") === "1";
  if (!doSwap) {
    return Response.json({
      ok: true,
      mint: mintStr,
      pair: pair.toBase58(),
      spotPriceSol: snapshot.spotPriceSol,
      reserveSolRaw: snapshot.reserveSolRaw,
      reserveProjectRaw: snapshot.reserveProjectRaw,
      note: "Add &swap=1 to attempt a 0.01 SOL buy via Omnipair",
      longShortBorrowUi:
        "TradingInterface long/short/borrow still mock — pool is live for swap",
    });
  }

  const wallet = {
    publicKey: kp.publicKey,
    signTransaction: async (tx: Transaction) => {
      tx.partialSign(kp);
      return tx;
    },
    signAllTransactions: async (txs: Transaction[]) => {
      for (const tx of txs) tx.partialSign(kp);
      return txs;
    },
  };

  try {
    const result = await sendOmnipairSwapTx({
      connection,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      wallet: wallet as any,
      snapshot,
      side: "buy",
      amountUi: 0.01,
      slippagePercent: 5,
    });
    return Response.json({
      ok: true,
      swap: "buy 0.01 SOL",
      signature: result.signature,
      fill: result.fill,
      pair: pair.toBase58(),
      spotPriceSol: snapshot.spotPriceSol,
    });
  } catch (e) {
    return Response.json(
      {
        ok: false,
        stage: "swap",
        pair: pair.toBase58(),
        spotPriceSol: snapshot.spotPriceSol,
        error: e instanceof Error ? e.message : String(e),
      },
      { status: 500 }
    );
  }
}
