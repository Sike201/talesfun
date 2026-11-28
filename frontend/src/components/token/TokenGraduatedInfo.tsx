"use client";

import { useEffect, useMemo, useState } from "react";
import { Copy, CheckCircle2, ArrowUpRight, ExternalLink } from "lucide-react";
import Link from "next/link";
import { useConnection } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import type { Token } from "@/types";
import type { OmnipairPoolSnapshot } from "@/lib/omnipairPoolState";
import {
  formatPairAge,
  formatUSD,
  shortenAddress,
} from "@/lib/utils";

type Props = {
  token: Token;
  copied: boolean;
  onCopyMint: () => void;
  omnipairSnapshot: OmnipairPoolSnapshot | null;
  solUsd?: number | null;
  creatorFeesSol?: number;
  /** Only the creator / fee recipient should see claimable fees. */
  showCreatorFees?: boolean;
  metadataPending: boolean;
};

function formatPooledAmount(n: number, maxFrac = 2): string {
  if (!Number.isFinite(n)) return "—";
  if (n >= 1_000) {
    return n.toLocaleString(undefined, { maximumFractionDigits: 0 });
  }
  return n.toLocaleString(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: maxFrac,
  });
}

export default function TokenGraduatedInfo({
  token,
  copied,
  onCopyMint,
  omnipairSnapshot,
  solUsd = null,
  creatorFeesSol,
  showCreatorFees = false,
  metadataPending,
}: Props) {
  const { connection } = useConnection();
  const about = String(token.about || token.description || "").trim();
  const pair = omnipairSnapshot?.pair.toBase58();
  const [pairCreatedAt, setPairCreatedAt] = useState<Date | null>(null);

  const pooled = useMemo(() => {
    if (!omnipairSnapshot) return null;
    const tokenUi =
      Number(omnipairSnapshot.reserveProjectRaw) /
      10 ** omnipairSnapshot.projectTokenDecimals;
    const solUi =
      Number(omnipairSnapshot.reserveSolRaw) /
      10 ** omnipairSnapshot.solDecimals;
    const spot = omnipairSnapshot.spotPriceSol;
    const tokenUsd =
      solUsd != null && Number.isFinite(spot)
        ? tokenUi * spot * solUsd
        : null;
    const solUsdVal =
      solUsd != null && Number.isFinite(solUi) ? solUi * solUsd : null;
    return { tokenUi, solUi, tokenUsd, solUsdVal };
  }, [omnipairSnapshot, solUsd]);

  useEffect(() => {
    if (!pair) {
      setPairCreatedAt(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const pairPk = new PublicKey(pair);
        let before: string | undefined;
        let oldestBlockTime: number | null = null;
        // Walk back a few pages; new demo pools are tiny.
        for (let page = 0; page < 6; page++) {
          const sigs = await connection.getSignaturesForAddress(pairPk, {
            limit: 1000,
            ...(before ? { before } : {}),
          });
          if (cancelled || sigs.length === 0) break;
          const last = sigs[sigs.length - 1]!;
          if (typeof last.blockTime === "number") {
            oldestBlockTime = last.blockTime;
          }
          if (sigs.length < 1000) break;
          before = last.signature;
        }
        if (!cancelled && oldestBlockTime != null) {
          setPairCreatedAt(new Date(oldestBlockTime * 1000));
        } else if (!cancelled) {
          setPairCreatedAt(token.createdAt);
        }
      } catch {
        if (!cancelled) setPairCreatedAt(token.createdAt);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [pair, connection, token.createdAt]);

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

        {pair && pooled ? (
          <>
            <div className="token-info-row">
              <dt>Pair created</dt>
              <dd className="text-sm font-semibold tabular-nums text-white">
                {pairCreatedAt ? formatPairAge(pairCreatedAt) : "…"}
              </dd>
            </div>
            <div className="token-info-row token-info-row--pool">
              <dt>Pooled {token.ticker}</dt>
              <dd>
                <span className="tabular-nums">
                  {formatPooledAmount(pooled.tokenUi, 0)}
                </span>
                <span className="tabular-nums">
                  {pooled.tokenUsd != null ? formatUSD(pooled.tokenUsd) : "—"}
                </span>
              </dd>
            </div>
            <div className="token-info-row token-info-row--pool">
              <dt>Pooled SOL</dt>
              <dd>
                <span className="tabular-nums">
                  {formatPooledAmount(pooled.solUi, 2)}
                </span>
                <span className="tabular-nums">
                  {pooled.solUsdVal != null ? formatUSD(pooled.solUsdVal) : "—"}
                </span>
              </dd>
            </div>
            <div className="token-info-row">
              <dt>Pool</dt>
              <dd>
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
                  View on Omnipair
                  <ArrowUpRight size={13} />
                </a>
              </dd>
            </div>
          </>
        ) : (
          <>
            <div className="token-info-row">
              <dt>Curve raised</dt>
              <dd className="text-sm font-semibold tabular-nums text-white">
                {token.solRaised.toFixed(2)} / {token.targetSOL} SOL
              </dd>
            </div>
            <div className="token-info-row">
              <dt>Created</dt>
              <dd className="text-sm font-semibold tabular-nums text-white">
                {formatPairAge(token.createdAt)}
              </dd>
            </div>
          </>
        )}

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
