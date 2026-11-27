"use client";

import { ArrowUpRight } from "lucide-react";
import type { Trade, TradeActivityType } from "@/types";
import { cn, formatNumber, formatUSD, shortenAddress } from "@/lib/utils";

function formatActivityTime(d: Date): string {
  return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

function activityLabel(trade: Trade): string {
  switch (trade.type) {
    case "long":
      return "Long";
    case "short":
      return "Short";
    case "borrow":
      return "Borrow";
    case "buy":
      return trade.source === "omnipair" ? "Swap buy" : "Buy";
    case "sell":
      return trade.source === "omnipair" ? "Swap sell" : "Sell";
    default:
      return trade.type;
  }
}

function activityTone(type: TradeActivityType): string {
  switch (type) {
    case "buy":
    case "long":
      return "bg-emerald-500/15 text-emerald-400";
    case "sell":
    case "short":
      return "bg-red-500/12 text-red-400";
    case "borrow":
      return "bg-sky-500/15 text-sky-300";
    default:
      return "bg-white/10 text-white/70";
  }
}

type Props = {
  ticker: string;
  trades: Trade[];
  solUsd: number | null;
  marketCapUsd: number;
  totalSupply?: number;
};

export default function TokenGraduatedActivity({
  ticker,
  trades,
  solUsd,
  marketCapUsd,
  totalSupply = 1_000_000_000,
}: Props) {
  return (
    <div className="token-activity-table-wrap">
        <div className="token-activity-cols hidden sm:grid">
          <span>Time</span>
          <span>Action</span>
          <span>Value</span>
          <span>{ticker}</span>
          <span>MCap</span>
          <span className="text-right">Trader</span>
        </div>

        <div className="max-h-[420px] overflow-y-auto scrollbar-hide">
          {trades.length > 0 ? (
            trades.map(trade => {
              const valueUsd =
                solUsd != null && solUsd > 0 && trade.solAmount > 0
                  ? trade.solAmount * solUsd
                  : null;
              const rowMcapUsd =
                trade.price > 0 && solUsd != null && solUsd > 0
                  ? trade.price * totalSupply * solUsd
                  : marketCapUsd;
              const isLending =
                trade.type === "long" ||
                trade.type === "short" ||
                trade.type === "borrow";
              return (
                <div key={trade.id} className="token-activity-row sm:grid">
                  <span className="tabular-nums text-white/45">
                    {formatActivityTime(trade.timestamp)}
                  </span>
                  <span>
                    <span
                      className={cn(
                        "inline-flex rounded-md px-2 py-0.5 text-xs font-semibold",
                        activityTone(trade.type)
                      )}
                    >
                      {activityLabel(trade)}
                    </span>
                  </span>
                  <span className="font-medium tabular-nums text-white/85">
                    {valueUsd != null
                      ? valueUsd >= 0.01
                        ? `$${valueUsd.toFixed(2)}`
                        : `$${valueUsd.toFixed(4)}`
                      : trade.solAmount > 0
                        ? `${trade.solAmount.toFixed(4)} SOL`
                        : "—"}
                  </span>
                  <span className="tabular-nums text-white/60">
                    {trade.tokenAmount > 0 ? formatNumber(trade.tokenAmount) : "—"}
                  </span>
                  <span className="tabular-nums text-white/50">
                    {isLending ? "—" : formatUSD(rowMcapUsd)}
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
              No on-chain activity yet. Swaps, leverage, and borrows show up here as they land.
            </p>
          )}
        </div>
    </div>
  );
}
