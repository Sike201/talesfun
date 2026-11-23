"use client";

import { Copy, CheckCircle2, ArrowUpRight, ExternalLink } from "lucide-react";
import Link from "next/link";
import type { Token } from "@/types";
import type { OmnipairPoolSnapshot } from "@/lib/omnipairPoolState";
import { shortenAddress } from "@/lib/utils";

type Props = {
  token: Token;
  copied: boolean;
  onCopyMint: () => void;
  omnipairSnapshot: OmnipairPoolSnapshot | null;
  creatorFeesSol?: number;
  /** Only the creator / fee recipient should see claimable fees. */
  showCreatorFees?: boolean;
  metadataPending: boolean;
};

export default function TokenGraduatedInfo({
  token,
  copied,
  onCopyMint,
  omnipairSnapshot,
  creatorFeesSol,
  showCreatorFees = false,
  metadataPending,
}: Props) {
  const about = String(token.about || token.description || "").trim();
  const pair = omnipairSnapshot?.pair.toBase58();

  return (
    <section className="token-info">
      <h2 className="mb-4 text-lg font-semibold tracking-tight text-white">Info</h2>
      <dl className="token-info-list">
        <div className="token-info-row">
          <dt>Contract</dt>
          <dd className="flex min-w-0 items-center gap-2">
            <code className="truncate font-mono text-sm text-white/70">
              {shortenAddress(token.mint, 6)}
            </code>
            <button
              type="button"
              onClick={onCopyMint}
              className="shrink-0 text-white/35 hover:text-white/70"
              aria-label="Copy mint"
            >
              {copied ? (
                <CheckCircle2 size={14} className="text-emerald-400" />
              ) : (
                <Copy size={14} />
              )}
            </button>
          </dd>
        </div>

        <div className="token-info-row">
          <dt>Liquidity</dt>
          <dd>
            {pair ? (
              <a
                href={`https://solscan.io/account/${pair}?cluster=devnet`}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 text-sm font-medium text-[#c8e6ff] hover:text-white"
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src="/omnipair/icon-dark-white.svg"
                  alt=""
                  className="h-4 w-4 opacity-90"
                />
                View Omnipair pool
                <ArrowUpRight size={13} />
              </a>
            ) : (
              <span className="text-sm text-white/45">Pool pending</span>
            )}
          </dd>
        </div>

        {token.twitter ? (
          <div className="token-info-row">
            <dt>X</dt>
            <dd>
              <a
                href={`https://twitter.com/${token.twitter}`}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-sm text-white/70 hover:text-white"
              >
                @{token.twitter.replace(/^@/, "")}
                <ExternalLink size={12} className="opacity-50" />
              </a>
            </dd>
          </div>
        ) : null}

        {/* Creator fees removed from the product. Legacy claimable balances only. */}
        {showCreatorFees &&
        typeof creatorFeesSol === "number" &&
        creatorFeesSol > 0 ? (
          <div className="token-info-row">
            <dt>Legacy creator fees</dt>
            <dd className="text-sm tabular-nums text-white/75">
              {creatorFeesSol.toFixed(4)} SOL claimable
            </dd>
          </div>
        ) : null}

        <div className="token-info-row token-info-row--block">
          <dt className="mb-2">About</dt>
          <dd>
            {metadataPending && !about ? (
              <div className="space-y-2 animate-pulse" aria-hidden>
                <div className="h-3 w-full rounded bg-white/10" />
                <div className="h-3 w-[92%] rounded bg-white/10" />
              </div>
            ) : about ? (
              <p className="text-sm leading-relaxed text-white/55 whitespace-pre-line">
                {about}
              </p>
            ) : (
              <p className="text-sm text-white/40">
                No description yet.{" "}
                <Link href="/docs" className="text-[#c8e6ff] hover:underline">
                  How Tales works
                </Link>
              </p>
            )}
          </dd>
        </div>
      </dl>
    </section>
  );
}
