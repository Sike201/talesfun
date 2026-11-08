import { NextRequest } from "next/server";
import {
  loadBootstrapKeeperKeypair,
  runOmnipairBootstrapKeeperCycle,
} from "@/lib/omnipairBootstrapKeeper";

/**
 * POST/GET /api/cron/omnipair-bootstrap?max=5
 *
 * Secured with `Authorization: Bearer <CRON_SECRET>` or `x-cron-secret` matching
 * `CRON_SECRET` or `OMNIPAIR_BOOTSTRAP_KEEPER_SECRET`.
 *
 * **Automation model:** submits `bootstrap_omnipair_pool` using a **server keypair**
 * (`OMNIPAIR_BOOTSTRAP_KEEPER_KEYPAIR_JSON`), not the user wallet. That keypair must be funded
 * (fees + ~0.2 SOL Omnipair creation) and should match the **ALT authority** for the bootstrap
 * lookup table if your deployment uses `NEXT_PUBLIC_OMNIPAIR_BOOTSTRAP_ALT`.
 *
 * Manual “Bootstrap Omnipair Pool” in the UI remains available as fallback.
 */
export async function POST(request: NextRequest) {
  return handle(request);
}

export async function GET(request: NextRequest) {
  return handle(request);
}

function authorize(request: NextRequest): boolean {
  const secret = (
    process.env.CRON_SECRET ||
    process.env.OMNIPAIR_BOOTSTRAP_KEEPER_SECRET ||
    ""
  ).trim();
  if (!secret) return false;
  if (request.headers.get("authorization") === `Bearer ${secret}`) return true;
  if (request.headers.get("x-cron-secret") === secret) return true;
  return false;
}

async function handle(request: NextRequest) {
  if (!authorize(request)) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!loadBootstrapKeeperKeypair()) {
    return Response.json(
      {
        error: "Keeper keypair not configured",
        hint:
          "Set OMNIPAIR_BOOTSTRAP_KEEPER_KEYPAIR_JSON to a JSON array of 64 u8 secret key bytes. Fund that pubkey. Prefer same key as Omnipair bootstrap ALT authority.",
      },
      { status: 503 }
    );
  }

  const maxRaw = request.nextUrl.searchParams.get("max");
  const maxParsed = maxRaw ? parseInt(maxRaw, 10) : 5;
  const maxMints =
    Number.isFinite(maxParsed) && maxParsed > 0 ? Math.min(maxParsed, 20) : 5;

  const started = Date.now();
  const result = await runOmnipairBootstrapKeeperCycle({ maxMints });
  const ms = Date.now() - started;

  console.info("[omnipair keeper] cron complete", { ms, ...result });

  return Response.json({ ms, ...result });
}
