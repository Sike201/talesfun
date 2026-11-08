export type LaunchpadTradePayload = {
  mint: string;
  signature: string;
  side: "buy" | "sell";
  sol_amount_raw: string;
  token_amount_raw: string;
  timestamp: string;
  wallet: string;
  price_sol: number;
  /** `bonding` = launchpad curve; `omnipair` = GAMM swap. Requires `trades.source` column in Supabase. */
  source?: "bonding" | "omnipair";
};

/** Fire-and-forget: record a confirmed bonding-curve trade in Supabase via API. */
export async function persistLaunchpadTrade(payload: LaunchpadTradePayload): Promise<void> {
  try {
    console.log(
      "[trade-history] persist mint:",
      payload.mint,
      "side:",
      payload.side,
      "sig:",
      payload.signature.slice(0, 8) + "…"
    );
    if (payload.side === "sell") {
      console.log("[higher.run] SELL ABOUT TO PERSIST TRADE");
      console.log("[higher.run] SELL persist payload:", JSON.stringify(payload));
    }
    console.log("[higher.run] FRONTEND persist trade payload:", JSON.stringify(payload));
    console.log("[higher.run] FRONTEND ABOUT TO POST /api/trades");
    const res = await fetch("/api/trades", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...payload,
        source: payload.source ?? "bonding",
      }),
    });
    const responseText = await res.text();
    let responseBody: unknown = responseText;
    try {
      responseBody = JSON.parse(responseText) as unknown;
    } catch {
      /* non-JSON body */
    }
    console.log("[higher.run] FRONTEND persist trade response:", res.status, responseBody);
    if (payload.side === "sell") {
      console.log("[higher.run] SELL /api/trades response:", res.status, responseBody);
    }
    if (!res.ok) {
      console.warn("[higher.run] FRONTEND trade persist failed:", res.status, responseBody);
    }
  } catch (e) {
    console.warn("[higher.run] FRONTEND trade persist error:", e);
  }
}
