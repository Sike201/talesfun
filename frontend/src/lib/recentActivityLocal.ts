/** Client-side fallback when Supabase trade index is unavailable. */

export type LocalTradeActivity = {
  mint: string;
  timestamp: string;
  signature: string;
  side: "buy" | "sell";
  sol_amount_raw?: string;
  token_amount_raw?: string;
  wallet?: string;
  price_sol?: number;
};

const STORAGE_KEY = "tales-recent-trade-activity-v1";
const HISTORY_KEY = "tales-trade-history-local-v1";
const MAX_HISTORY = 80;

export function readLocalTradeActivity(): Record<string, LocalTradeActivity> {
  if (typeof window === "undefined") return {};
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, LocalTradeActivity>;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export function recordLocalTradeActivity(entry: LocalTradeActivity): void {
  if (typeof window === "undefined") return;
  try {
    const prev = readLocalTradeActivity();
    const existing = prev[entry.mint];
    if (
      !existing ||
      new Date(entry.timestamp).getTime() >
        new Date(existing.timestamp).getTime()
    ) {
      prev[entry.mint] = entry;
      localStorage.setItem(STORAGE_KEY, JSON.stringify(prev));
      window.dispatchEvent(
        new CustomEvent("tales:recent-activity", { detail: entry })
      );
    }

    const histRaw = localStorage.getItem(HISTORY_KEY);
    const hist = (
      histRaw ? (JSON.parse(histRaw) as Record<string, LocalTradeActivity[]>) : {}
    ) as Record<string, LocalTradeActivity[]>;
    const list = hist[entry.mint] ?? [];
    if (!list.some(t => t.signature === entry.signature)) {
      list.unshift(entry);
      hist[entry.mint] = list.slice(0, MAX_HISTORY);
      localStorage.setItem(HISTORY_KEY, JSON.stringify(hist));
    }
  } catch {
    /* ignore quota */
  }
}

export function readLocalTradeHistory(mint: string): LocalTradeActivity[] {
  if (typeof window === "undefined") return [];
  try {
    const histRaw = localStorage.getItem(HISTORY_KEY);
    if (!histRaw) return [];
    const hist = JSON.parse(histRaw) as Record<string, LocalTradeActivity[]>;
    return Array.isArray(hist[mint]) ? hist[mint] : [];
  } catch {
    return [];
  }
}
