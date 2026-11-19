"use client";

import { Copy, ArrowUpRight } from "lucide-react";
import toast from "react-hot-toast";
import { shortenAddress, formatNumber, cn } from "@/lib/utils";
import type { OmnipairPoolSnapshot } from "@/lib/omnipairPoolState";

type Props = {
  ticker: string;
  snapshot: OmnipairPoolSnapshot | null;
  loading: boolean;
  error: string | null;
};

function copyText(label: string, text: string) {
  void navigator.clipboard.writeText(text);
  toast.success(`${label} copied`);
}

export default function OmnipairPoolCard({
  ticker,
  snapshot,
  loading,
  error,
}: Props) {
  const live = !!snapshot && !error;

  return (
    <div className="rounded-xl border border-white/10 bg-zinc-950/90 p-4">
      <div className="mb-3 flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/omnipair/icon-dark-white.svg"
            alt=""
            className="h-5 w-5 shrink-0 opacity-90"
          />
          <h3 className="truncate text-sm font-bold text-white">
            {ticker} · Omnipair pool
          </h3>
          <span
            className={cn(
              "shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold",
              live
                ? "bg-emerald-500/15 text-emerald-300"
                : error
                  ? "bg-red-500/15 text-red-300"
                  : "bg-amber-500/15 text-amber-200"
            )}
          >
            {live ? "Swap live" : error ? "Pool read error" : "Loading pool…"}
          </span>
        </div>
        <a
          href="https://docs.omnipair.fi/developers/overview"
          target="_blank"
          rel="noopener noreferrer"
          title="Omnipair developer docs"
          className="shrink-0 text-white/35 transition-colors hover:text-white/70"
        >
          <ArrowUpRight size={14} />
        </a>
      </div>

      {error ? (
        <p className="mb-3 text-xs leading-relaxed text-red-300/90">{error}</p>
      ) : null}

      {loading && !snapshot ? (
        <div className="mb-3 animate-pulse space-y-2" aria-hidden>
          <div className="h-3 w-full rounded bg-white/10" />
          <div className="h-3 w-4/5 rounded bg-white/10" />
        </div>
      ) : null}

      {snapshot ? (
        <div className="space-y-2.5 text-xs">
          <div className="flex justify-between gap-2">
            <span className="shrink-0 text-white/40">Pair</span>
            <span className="flex min-w-0 items-center justify-end gap-1">
              <code className="max-w-[180px] truncate font-mono text-[11px] text-white/70">
                {shortenAddress(snapshot.pair.toBase58())}
              </code>
              <button
                type="button"
                className="shrink-0 text-white/35 hover:text-white/70"
                aria-label="Copy pair address"
                onClick={() => copyText("Pair", snapshot.pair.toBase58())}
              >
                <Copy size={12} />
              </button>
            </span>
          </div>
          <div className="flex justify-between gap-2">
            <span className="shrink-0 text-white/40">LP mint</span>
            <span className="flex min-w-0 items-center justify-end gap-1">
              <code className="max-w-[180px] truncate font-mono text-[11px] text-white/70">
                {shortenAddress(snapshot.lpMint.toBase58())}
              </code>
              <button
                type="button"
                className="shrink-0 text-white/35 hover:text-white/70"
                aria-label="Copy LP mint"
                onClick={() => copyText("LP mint", snapshot.lpMint.toBase58())}
              >
                <Copy size={12} />
              </button>
            </span>
          </div>
          <div className="flex justify-between gap-2">
            <span className="text-white/40">{ticker} reserve</span>
            <span className="text-right font-semibold tabular-nums text-white/80">
              {formatNumber(
                Number(snapshot.reserveProjectRaw) /
                  10 ** snapshot.projectTokenDecimals
              )}
            </span>
          </div>
          <div className="flex justify-between gap-2">
            <span className="text-white/40">SOL reserve</span>
            <span className="text-right font-semibold tabular-nums text-white/80">
              {(
                Number(snapshot.reserveSolRaw) /
                10 ** snapshot.solDecimals
              ).toLocaleString(undefined, {
                minimumFractionDigits: 2,
                maximumFractionDigits: 4,
              })}{" "}
              SOL
            </span>
          </div>
          <div className="flex justify-between gap-2">
            <span className="text-white/40">Your LP</span>
            <span className="text-right font-medium tabular-nums text-white/70">
              {formatNumber(
                Number(snapshot.walletLpBalanceRaw) / 10 ** snapshot.lpDecimals
              )}
            </span>
          </div>
          <div className="flex justify-between gap-2 border-t border-white/10 pt-2">
            <span className="text-white/40">Spot (pool)</span>
            <span className="font-medium tabular-nums text-white/80">
              {snapshot.spotPriceSol > 0
                ? `${snapshot.spotPriceSol.toExponential(4)} SOL / ${ticker}`
                : "—"}
            </span>
          </div>
          <a
            href={`https://solscan.io/account/${snapshot.pair.toBase58()}?cluster=devnet`}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 pt-1 text-[11px] font-medium text-[#c8e6ff] hover:text-white"
          >
            View pair on Solscan <ArrowUpRight size={11} />
          </a>
        </div>
      ) : !error && !loading ? (
        <p className="text-xs text-white/45">No snapshot yet.</p>
      ) : null}
    </div>
  );
}
