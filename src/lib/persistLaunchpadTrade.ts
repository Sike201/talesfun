export type LaunchpadTradePayload = {
  mint: string;
  signature: string;
  side: "buy" | "sell";
  sol_amount_raw: string;
  token_amount_raw: string;
  timestamp: string;
  wallet: string;
  price_sol: number;
};

/** Record a confirmed bonding-curve trade in Supabase via API. */
export async function persistLaunchpadTrade(payload: LaunchpadTradePayload): Promise<void> {
  try {
    console.log("[higher.run] persist trade payload:", JSON.stringify(payload));
    console.log("[higher.run] ABOUT TO POST /api/trades");
    const res = await fetch("/api/trades", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const responseText = await res.text();
    let responseBody: unknown = responseText;
    try {
      responseBody = JSON.parse(responseText) as unknown;
    } catch {
      /* non-JSON body */
    }
    console.log("[higher.run] persist trade response:", res.status, responseBody);
    if (!res.ok) {
      console.warn("[higher.run] trade persist failed:", res.status, responseBody);
    }
  } catch (e) {
    console.warn("[higher.run] trade persist error:", e);
  }
}
