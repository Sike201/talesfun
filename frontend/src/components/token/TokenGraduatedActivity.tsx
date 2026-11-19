"use client";

import { ArrowUpRight } from "lucide-react";
import type { Trade } from "@/types";
import { cn, formatNumber, formatUSD, shortenAddress } from "@/lib/utils";

function formatActivityTime(d: Date): string {
  return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

type Props = {
  ticker: string;
  trades: Trade[];
  solUsd: number | null;
  marketCapUsd: number;
};

export default function TokenGraduatedActivity({
  ticker,
  trades,
  solUsd,
  marketCapUsd,
}: Props) {
  return (
    <div className="token-activity-table-wrap">
        <div className="token-activity-cols hidden sm:grid">
          <span>Time</span>
          <span>Trade</span>
          <span>Value</span>
          <span>{ticker}</span>
          <span>MCap</span>
          <span className="text-right">Trader</span>
        </div>

        <div className="max-h-[420px] overflow-y-auto scrollbar-hide">
          {trades.length > 0 ? (
            trades.map(trade => {
              const valueUsd =
                solUsd != null && solUsd > 0
                  ? trade.solAmount * solUsd
                  : null;
              return (
                <div key={trade.id} className="token-activity-row sm:grid">
                  <span className="tabular-nums text-white/45">
                    {formatActivityTime(trade.timestamp)}
                  </span>
                  <span>
                    <span
                      className={cn(
                        "inline-flex rounded-md px-2 py-0.5 text-xs font-semibold capitalize",
                        trade.type === "buy"
                          ? "bg-emerald-500/15 text-emerald-400"
                          : "bg-red-500/12 text-red-400"
                      )}
                    >
                      {trade.type}
                      {trade.source === "omnipair" ? (
                        <span className="ml-1 text-[10px] font-medium text-white/35">
                          · Dusk
                        </span>
                      ) : null}
                    </span>
                  </span>
                  <span className="font-medium tabular-nums text-white/85">
                    {valueUsd != null ? `$${valueUsd.toFixed(2)}` : "—"}
                  </span>
                  <span className="tabular-nums text-white/60">
                    {formatNumber(trade.tokenAmount)}
                  </span>
                  <span className="tabular-nums text-white/50">
                    {formatUSD(marketCapUsd)}
                  </span>
                  <span className="flex items-center justify-end gap-2">
                    <span
                      className="truncate font-mono text-[11px] text-white/40"
                      title={trade.trader}
                    >
                      {trade.trader ? shortenAddress(trade.trader) : "—"}
                    </span>
                    {trade.txSignature ? (
                      <a
                        href={`https://solscan.io/tx/${trade.txSignature}?cluster=devnet`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="shrink-0 text-white/30 transition-colors hover:text-white/70"
                        aria-label="View transaction"
                      >
                        <ArrowUpRight size={13} />
                      </a>
                    ) : null}
                  </span>
                </div>
              );
            })
          ) : (
            <p className="px-1 py-14 text-center text-sm text-white/40">
              No trades indexed yet. Swap from the panel on the right — activity saves locally until Supabase is bootstrapped.
            </p>
          )}
        </div>
    </div>
  );
}
