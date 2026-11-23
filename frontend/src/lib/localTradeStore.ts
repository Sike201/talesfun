/**
 * Local on-disk trade journal used when Supabase is unreachable.
 * Charts/volume can read this so demo/E2E still show real indexed fills.
 */
import fs from "node:fs";
import path from "node:path";
import type { CanonicalTradeRow } from "./persistCanonicalTrade";

const STORE_PATH = path.join(process.cwd(), ".data", "onchain-trades.json");

type StoreFile = { trades: CanonicalTradeRow[] };

function readStore(): StoreFile {
  try {
    if (!fs.existsSync(STORE_PATH)) return { trades: [] };
    const raw = fs.readFileSync(STORE_PATH, "utf8");
    const parsed = JSON.parse(raw) as StoreFile;
    return { trades: Array.isArray(parsed.trades) ? parsed.trades : [] };
  } catch {
    return { trades: [] };
  }
}

function writeStore(store: StoreFile) {
  fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
  fs.writeFileSync(STORE_PATH, JSON.stringify(store, null, 2));
}

export function upsertLocalTrade(row: CanonicalTradeRow): void {
  const store = readStore();
  const i = store.trades.findIndex((t) => t.signature === row.signature);
  if (i >= 0) store.trades[i] = row;
  else store.trades.push(row);
  writeStore(store);
}

export function listLocalTrades(mint?: string): CanonicalTradeRow[] {
  const trades = readStore().trades;
  if (!mint) return trades;
  return trades.filter((t) => t.mint === mint);
}

export function sumLocalVolume24hLamports(mint?: string): string {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  let sum = BigInt(0);
  for (const t of listLocalTrades(mint)) {
    const ts = Date.parse(t.timestamp);
    if (!Number.isFinite(ts) || ts < cutoff) continue;
    try {
      sum += BigInt(t.sol_amount_raw);
    } catch {
      /* ignore */
    }
  }
  return sum.toString();
}
