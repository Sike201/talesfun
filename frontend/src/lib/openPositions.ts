/**
 * Client-side open leverage / borrow positions for Positions tab + panel.
 * Persists per mint so the Positions feed stays visible after refresh.
 */

export type OpenPositionKind = "trade" | "loan";

export type OpenLeveragePosition = {
  id: string;
  mint: string;
  wallet: string;
  /** trade = leverage long/short; loan = borrow against collateral */
  kind: OpenPositionKind;
  direction: "long" | "short";
  leverage: number;
  marginUi: number;
  entrySpotSol: number;
  entrySolUsd: number;
  signature: string;
  openedAt: string;
  /** Borrow size in SOL (loans) */
  borrowSolUi?: number;
};

const STORAGE_KEY = "higher:open-positions:v1";

function readAll(): OpenLeveragePosition[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as OpenLeveragePosition[];
    if (!Array.isArray(parsed)) return [];
    return parsed.map(p => ({
      ...p,
      kind: p.kind === "loan" ? "loan" : "trade",
    }));
  } catch {
    return [];
  }
}

function writeAll(rows: OpenLeveragePosition[]) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(rows.slice(0, 200)));
  } catch {
    /* ignore quota */
  }
}

export function listOpenPositions(mint?: string): OpenLeveragePosition[] {
  const all = readAll();
  if (!mint) return all;
  return all.filter(p => p.mint === mint);
}

export function upsertOpenPosition(
  pos: Omit<OpenLeveragePosition, "id" | "openedAt" | "kind"> & {
    id?: string;
    openedAt?: string;
    kind?: OpenPositionKind;
    borrowSolUi?: number;
  }
): OpenLeveragePosition {
  const kind: OpenPositionKind = pos.kind ?? "trade";
  const row: OpenLeveragePosition = {
    id: pos.id ?? `${pos.signature || Date.now()}`,
    mint: pos.mint,
    wallet: pos.wallet,
    kind,
    direction: pos.direction,
    leverage: pos.leverage,
    marginUi: pos.marginUi,
    entrySpotSol: pos.entrySpotSol,
    entrySolUsd: pos.entrySolUsd,
    signature: pos.signature,
    openedAt: pos.openedAt ?? new Date().toISOString(),
    borrowSolUi: pos.borrowSolUi,
  };
  const rest = readAll().filter(
    p =>
      !(
        p.mint === row.mint &&
        p.wallet === row.wallet &&
        p.direction === row.direction &&
        (p.kind ?? "trade") === kind
      )
  );
  writeAll([row, ...rest]);
  if (typeof window !== "undefined") {
    window.dispatchEvent(
      new CustomEvent("higher:positions-changed", { detail: { mint: row.mint } })
    );
  }
  return row;
}

export function dismissOpenPosition(id: string) {
  writeAll(readAll().filter(p => p.id !== id));
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("higher:positions-changed", { detail: {} }));
  }
}

/** Mark-to-market position value (USD). Leverage stays fixed. */
export function markPositionValueUsd(
  pos: Pick<
    OpenLeveragePosition,
    "direction" | "leverage" | "marginUi" | "entrySpotSol" | "entrySolUsd"
  >,
  spotSol: number
): { entryUsd: number; markUsd: number } {
  const entryUsd =
    pos.direction === "long"
      ? pos.marginUi * pos.entrySpotSol * pos.entrySolUsd * pos.leverage
      : pos.marginUi * pos.entrySolUsd * pos.leverage;
  const ratio =
    pos.entrySpotSol > 0 && spotSol > 0 ? spotSol / pos.entrySpotSol : 1;
  const markUsd =
    pos.direction === "long" ? entryUsd * ratio : entryUsd * (2 - ratio);
  return { entryUsd, markUsd: Math.max(0, markUsd) };
}
