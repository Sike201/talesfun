"use client";

import { useState } from "react";
import type { Token, Trade } from "@/types";
import { cn, formatNumber } from "@/lib/utils";
import TokenGraduatedActivity from "@/components/token/TokenGraduatedActivity";
import TokenHoldersList from "@/components/token/TokenHoldersList";
import { useMintHolders } from "@/hooks/useMintHolders";

export type GraduatedFeedSection = "activity" | "holders";

type Props = {
  token: Token;
  trades: Trade[];
  solUsd: number | null;
  marketCapUsd: number;
  holderCount: number | null;
  holderLoading: boolean;
  /** Kept for call-site compatibility; LP UI removed. */
  omnipairPoolSnapshot?: unknown;
  poolReady?: boolean;
  initialSection?: GraduatedFeedSection;
};

export default function TokenGraduatedFeed({
  token,
  trades,
  solUsd,
  marketCapUsd,
  holderCount,
  holderLoading,
  initialSection = "activity",
}: Props) {
  const [section, setSection] = useState<GraduatedFeedSection>(
    initialSection === "holders" ? "holders" : "activity"
  );
  // Always fetch the list so count matches the Holders table (excludes pool vault).
  const { holders, loading: holdersListLoading, count: listCount } = useMintHolders(
    token.mint,
    true,
    token.gammPool ? [token.gammPool] : []
  );

  const displayCount =
    listCount > 0
      ? listCount
      : holdersListLoading
        ? holderCount
        : listCount === 0 && !holdersListLoading
          ? 0
          : holderCount;

  return (
    <section className="token-feed">
      <div className="token-feed-tabs" role="tablist" aria-label="Token feed">
        <button
          type="button"
          role="tab"
          aria-selected={section === "activity"}
          onClick={() => setSection("activity")}
          className={cn(
            "token-feed-tab",
            section === "activity" && "token-feed-tab-active"
          )}
        >
          Activity
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={section === "holders"}
          onClick={() => setSection("holders")}
          className={cn(
            "token-feed-tab",
            section === "holders" && "token-feed-tab-active"
          )}
        >
          Holders
          <span className="ml-2 text-sm font-normal text-white/40">
            {holdersListLoading && holderLoading
              ? "…"
              : `${formatNumber(displayCount ?? 0)}`}
          </span>
        </button>
      </div>

      <div className="token-feed-panel">
        {section === "activity" ? (
          <TokenGraduatedActivity
            ticker={token.ticker}
            trades={trades}
            solUsd={solUsd}
            marketCapUsd={marketCapUsd}
            totalSupply={token.totalSupply}
          />
        ) : (
          <TokenHoldersList
            holders={holders}
            loading={holdersListLoading}
            ticker={token.ticker}
            totalSupply={token.totalSupply}
          />
        )}
      </div>
    </section>
  );
}
