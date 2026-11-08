import { NextRequest } from "next/server";
import {
  getIndexerRpcConnection,
  runOmnipairSwapIndexer,
} from "@/lib/omnipairIndexer";

/**
 * POST or GET /api/cron/omnipair-trades
 * Secured with Authorization: Bearer <CRON_SECRET> or x-cron-secret header.
 *
 * Polls recent signatures per graduated `tokens.gamm_pool`, indexes Omnipair swaps into `trades`
 * with source = omnipair (idempotent on tx signature).
 */
export async function POST(request: NextRequest) {
  return handleCron(request);
}

export async function GET(request: NextRequest) {
  return handleCron(request);
}

function authorize(request: NextRequest): boolean {
  const secret =
    process.env.CRON_SECRET?.trim() ||
    process.env.INDEXER_SECRET?.trim() ||
    "";
  if (!secret) {
    console.warn(
      "[omnipair:indexer] CRON_SECRET / INDEXER_SECRET not set — refusing run"
    );
    return false;
  }
  const auth = request.headers.get("authorization");
  if (auth === `Bearer ${secret}`) return true;
  if (request.headers.get("x-cron-secret") === secret) return true;
  return false;
}

async function handleCron(request: NextRequest) {
  if (!authorize(request)) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const limitRaw = request.nextUrl.searchParams.get("limitPerPair");
  const limitPerPair = limitRaw ? parseInt(limitRaw, 10) : undefined;
  const connection = getIndexerRpcConnection();

  const started = Date.now();
  const result = await runOmnipairSwapIndexer(connection, {
    limitPerPair:
      limitPerPair != null && Number.isFinite(limitPerPair) && limitPerPair > 0
        ? limitPerPair
        : undefined,
  });
  const ms = Date.now() - started;

  console.info("[omnipair:indexer] cron run complete", { ms, ...result });

  return Response.json({ ms, ...result });
}
