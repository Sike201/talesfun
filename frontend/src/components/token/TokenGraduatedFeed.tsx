"use client";

import { useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import type { Token, Trade } from "@/types";
import type { OmnipairPoolSnapshot } from "@/lib/omnipairPoolState";
import { cn, formatNumber } from "@/lib/utils";
import TokenGraduatedActivity from "@/components/token/TokenGraduatedActivity";
import { OmnipairLiquidityPanel } from "@/components/ui/TradingInterface";

export type GraduatedFeedSection = "activity" | "liquidity";

type Props = {
  token: Token;
  trades: Trade[];
  solUsd: number | null;
  marketCapUsd: number;
  holderCount: number | null;
  holderLoading: boolean;
  omnipairPoolSnapshot: OmnipairPoolSnapshot | null;
  poolReady: boolean;
  initialSection?: GraduatedFeedSection;
};

export default function TokenGraduatedFeed({
  token,
  trades,
  solUsd,
  marketCapUsd,
  holderCount,
  holderLoading,
  omnipairPoolSnapshot,
  poolReady,
  initialSection = "activity",
}: Props) {
  const { connected } = useWallet();
  const [section, setSection] = useState<GraduatedFeedSection>(initialSection);

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
          <span className="ml-2 text-sm font-normal text-white/40">
            {holderLoading ? "…" : `${formatNumber(holderCount ?? 0)} holders`}
          </span>
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={section === "liquidity"}
          onClick={() => setSection("liquidity")}
          className={cn(
            "token-feed-tab",
            section === "liquidity" && "token-feed-tab-active"
          )}
        >
          Add LP
        </button>
      </div>

      <div className="token-feed-panel">
        {section === "activity" ? (
          <TokenGraduatedActivity
            ticker={token.ticker}
            trades={trades}
            solUsd={solUsd}
            marketCapUsd={marketCapUsd}
          />
        ) : (
          <div className="token-liquidity-panel">
            {poolReady && omnipairPoolSnapshot ? (
              <OmnipairLiquidityPanel
                token={token}
                connected={connected}
                omnipairPoolSnapshot={omnipairPoolSnapshot}
              />
            ) : (
              <p className="py-12 text-center text-sm text-white/45">
                Omnipair pool must be live before you can add liquidity. Bootstrap or connect to a graduated pool first.
              </p>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
