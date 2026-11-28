"use client";

import { useEffect, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import type { Token, Trade } from "@/types";
import { cn, formatNumber } from "@/lib/utils";
import TokenGraduatedActivity from "@/components/token/TokenGraduatedActivity";
import TokenHoldersList from "@/components/token/TokenHoldersList";
import TokenPositionsList from "@/components/token/TokenPositionsList";
import { useMintHolders } from "@/hooks/useMintHolders";
import { listOpenPositions } from "@/lib/openPositions";
import type { OmnipairPoolSnapshot } from "@/lib/omnipairPoolState";

export type GraduatedFeedSection = "activity" | "holders" | "positions";

type Props = {
  token: Token;
  trades: Trade[];
  solUsd: number | null;
  holderCount: number | null;
  holderLoading: boolean;
  omnipairPoolSnapshot?: OmnipairPoolSnapshot | null;
  poolReady?: boolean;
  initialSection?: GraduatedFeedSection;
};

export default function TokenGraduatedFeed({
  token,
  trades,
  solUsd,
  holderCount,
  holderLoading,
  omnipairPoolSnapshot = null,
  initialSection = "activity",
}: Props) {
  const { publicKey } = useWallet();
  const [section, setSection] = useState<GraduatedFeedSection>(
    initialSection === "holders" || initialSection === "positions"
      ? initialSection
      : "activity"
  );
  const [myPositionCount, setMyPositionCount] = useState(0);
  const walletKey = publicKey?.toBase58() ?? null;

  useEffect(() => {
    if (!walletKey) {
      setMyPositionCount(0);
      return;
    }
    const syncLocal = () => {
      const n = listOpenPositions(token.mint).filter(
        p => p.wallet.toLowerCase() === walletKey.toLowerCase()
      ).length;
      setMyPositionCount(n);
    };
    syncLocal();
    const onChange = () => syncLocal();
    window.addEventListener("higher:positions-changed", onChange);
    window.addEventListener("storage", onChange);
    return () => {
      window.removeEventListener("higher:positions-changed", onChange);
      window.removeEventListener("storage", onChange);
    };
  }, [walletKey, token.mint]);

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

  const spotSol =
    omnipairPoolSnapshot?.spotPriceSol && omnipairPoolSnapshot.spotPriceSol > 0
      ? omnipairPoolSnapshot.spotPriceSol
      : token.currentPrice;

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
          aria-selected={section === "positions"}
          onClick={() => setSection("positions")}
          className={cn(
            "token-feed-tab",
            section === "positions" && "token-feed-tab-active"
          )}
        >
          Positions
          {walletKey ? (
            <span className="ml-2 text-sm font-normal text-white/40">
              {formatNumber(myPositionCount)}
            </span>
          ) : null}
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
          />
        ) : section === "positions" ? (
          <TokenPositionsList
            mint={token.mint}
            ticker={token.ticker}
            imageUrl={token.imageUrl}
            trades={trades}
            spotSol={spotSol}
            solUsd={solUsd}
            connectedWallet={walletKey}
            omnipairPoolSnapshot={omnipairPoolSnapshot}
            onCountChange={setMyPositionCount}
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
