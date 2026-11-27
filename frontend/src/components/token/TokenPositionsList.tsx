"use client";

import { useEffect, useMemo, useState } from "react";
import type { Trade } from "@/types";
import { cn, formatUSD, shortenAddress } from "@/lib/utils";
import {
  dismissOpenPosition,
  listOpenPositions,
  markPositionValueUsd,
  type OpenLeveragePosition,
} from "@/lib/openPositions";

type Props = {
  mint: string;
  trades: Trade[];
  spotSol: number;
  solUsd: number | null;
  connectedWallet?: string | null;
};

function fromTrades(trades: Trade[], mint: string): OpenLeveragePosition[] {
  const out: OpenLeveragePosition[] = [];
  const seen = new Set<string>();
  for (const t of trades) {
    if (t.type !== "long" && t.type !== "short") continue;
    const key = `${t.trader}:${t.type}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      id: t.txSignature || `${t.trader}-${t.type}`,
      mint,
      wallet: t.trader,
      direction: t.type,
      leverage: 0,
      marginUi: t.type === "short" ? t.solAmount : t.tokenAmount,
      entrySpotSol: t.price > 0 ? t.price : 0,
      entrySolUsd: 0,
      signature: t.txSignature,
      openedAt:
        t.timestamp instanceof Date
          ? t.timestamp.toISOString()
          : new Date(t.timestamp).toISOString(),
    });
  }
  return out;
}

export default function TokenPositionsList({
  mint,
  trades,
  spotSol,
  solUsd,
  connectedWallet,
}: Props) {
  const [local, setLocal] = useState<OpenLeveragePosition[]>([]);

  useEffect(() => {
    const refresh = () => setLocal(listOpenPositions(mint));
    refresh();
    const onChange = () => refresh();
    window.addEventListener("higher:positions-changed", onChange);
    window.addEventListener("storage", onChange);
    return () => {
      window.removeEventListener("higher:positions-changed", onChange);
      window.removeEventListener("storage", onChange);
    };
  }, [mint]);

  const rows = useMemo(() => {
    const fromActivity = fromTrades(trades, mint);
    const byKey = new Map<string, OpenLeveragePosition>();
    for (const p of fromActivity) byKey.set(`${p.wallet}:${p.direction}`, p);
    // Local (connected trader) rows win — they carry locked leverage + entry.
    for (const p of local) byKey.set(`${p.wallet}:${p.direction}`, p);
    return Array.from(byKey.values()).sort(
      (a, b) => +new Date(b.openedAt) - +new Date(a.openedAt)
    );
  }, [trades, mint, local]);

  if (rows.length === 0) {
    return (
      <p className="px-1 py-14 text-center text-sm text-white/40">
        No open long/short positions yet. Open one from Leverage.
      </p>
    );
  }

  const usd = solUsd ?? 140;

  return (
    <div className="token-activity-table-wrap">
      <div className="token-activity-cols hidden grid-cols-[1fr_70px_1fr_1fr] sm:grid sm:!grid-cols-[1fr_70px_90px_1fr]">
        <span>Trader</span>
        <span>Side</span>
        <span className="text-right">Leverage</span>
        <span className="text-right">Position value</span>
      </div>
      <div className="max-h-[420px] overflow-y-auto scrollbar-hide">
        {rows.map(p => {
          const hasMark = p.leverage > 0 && p.entrySpotSol > 0;
          const { entryUsd, markUsd } = hasMark
            ? markPositionValueUsd(p, spotSol)
            : {
                entryUsd: 0,
                markUsd:
                  p.direction === "long"
                    ? p.marginUi * (spotSol > 0 ? spotSol : 0) * usd
                    : p.marginUi * usd,
              };
          const underwater = hasMark && markUsd < entryUsd;
          const mine =
            connectedWallet &&
            p.wallet.toLowerCase() === connectedWallet.toLowerCase();

          return (
            <div
              key={p.id}
              className="token-activity-row grid grid-cols-[1fr_auto] items-center gap-2 sm:grid-cols-[1fr_70px_90px_1fr]"
            >
              <span className="flex min-w-0 items-center gap-2">
                <a
                  href={`https://solscan.io/account/${p.wallet}?cluster=devnet`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="truncate font-mono text-[12px] text-white/70 hover:text-white"
                  title={p.wallet}
                >
                  {mine ? "You" : shortenAddress(p.wallet)}
                </a>
              </span>
              <span
                className={cn(
                  "text-[11px] font-semibold uppercase tracking-wide",
                  p.direction === "long" ? "text-emerald-400" : "text-red-400"
                )}
              >
                {p.direction}
              </span>
              <span className="text-right tabular-nums text-white/75">
                {p.leverage > 0 ? `${p.leverage.toFixed(1)}x` : "—"}
                {p.leverage > 0 ? (
                  <span className="ml-1 text-[10px] text-white/35">locked</span>
                ) : null}
              </span>
              <span className="flex items-center justify-end gap-2">
                <span
                  className={cn(
                    "tabular-nums",
                    underwater ? "text-red-400" : "text-white/80"
                  )}
                >
                  {markUsd > 0 ? formatUSD(markUsd) : "—"}
                </span>
                {mine ? (
                  <button
                    type="button"
                    className="text-[10px] text-white/35 hover:text-white/70"
                    onClick={() => dismissOpenPosition(p.id)}
                  >
                    Hide
                  </button>
                ) : null}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
