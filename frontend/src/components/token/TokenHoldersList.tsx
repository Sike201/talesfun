"use client";

import type { MintHolder } from "@/lib/tokenHolders";
import { FIXED_SUPPLY } from "@/types";
import { formatNumber, shortenAddress } from "@/lib/utils";

type Props = {
  holders: MintHolder[];
  loading: boolean;
  ticker: string;
  totalSupply?: number;
};

export default function TokenHoldersList({
  holders,
  loading,
  ticker,
  totalSupply = FIXED_SUPPLY,
}: Props) {
  if (loading && holders.length === 0) {
    return (
      <p className="px-1 py-14 text-center text-sm text-white/40">Loading holders…</p>
    );
  }

  if (!loading && holders.length === 0) {
    return (
      <p className="px-1 py-14 text-center text-sm text-white/40">
        No holders found on-chain yet.
      </p>
    );
  }

  const supply = totalSupply > 0 ? totalSupply : FIXED_SUPPLY;

  return (
    <div className="token-activity-table-wrap">
      <div className="token-activity-cols hidden grid-cols-[1fr_1fr_80px] sm:grid sm:!grid-cols-[1fr_1fr_80px]">
        <span>Wallet</span>
        <span className="text-right">{ticker}</span>
        <span className="text-right">Share</span>
      </div>
      <div className="max-h-[420px] overflow-y-auto scrollbar-hide">
        {holders.map((h, i) => {
          const pct = supply > 0 ? (h.uiAmount / supply) * 100 : 0;
          return (
            <div
              key={h.owner}
              className="token-activity-row grid grid-cols-[auto_1fr_auto] items-center gap-3 sm:grid-cols-[1fr_1fr_80px]"
            >
              <span className="flex min-w-0 items-center gap-2">
                <span className="w-5 shrink-0 text-[11px] tabular-nums text-white/30">
                  {i + 1}
                </span>
                <a
                  href={`https://solscan.io/account/${h.owner}?cluster=devnet`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="truncate font-mono text-[12px] text-white/70 hover:text-white"
                  title={h.owner}
                >
                  {shortenAddress(h.owner)}
                </a>
              </span>
              <span className="text-right tabular-nums text-white/80">
                {formatNumber(h.uiAmount)}
              </span>
              <span className="text-right tabular-nums text-white/45">
                {pct >= 0.01 ? `${pct.toFixed(2)}%` : "<0.01%"}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
