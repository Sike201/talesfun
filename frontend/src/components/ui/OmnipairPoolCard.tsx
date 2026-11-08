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
    <div className="bg-white rounded-lg p-4">
      <div className="flex items-center justify-between mb-3 gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <h3 className="text-sm font-bold text-gray-900 truncate">
            {ticker} · Omnipair
          </h3>
          <span
            className={cn(
              "text-[10px] font-semibold px-2 py-0.5 rounded-full shrink-0",
              live
                ? "bg-emerald-50 text-emerald-700"
                : error
                  ? "bg-red-50 text-red-700"
                  : "bg-amber-50 text-amber-800"
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
          className="text-gray-400 hover:text-gray-700 transition-colors shrink-0"
        >
          <ArrowUpRight size={14} />
        </a>
      </div>

      {error ? (
        <p className="text-xs text-red-600 mb-3 leading-relaxed">{error}</p>
      ) : null}

      {loading && !snapshot ? (
        <div className="space-y-2 animate-pulse mb-3" aria-hidden>
          <div className="h-3 bg-gray-100 rounded w-full" />
          <div className="h-3 bg-gray-100 rounded w-4/5" />
        </div>
      ) : null}

      {snapshot ? (
        <div className="space-y-2.5 text-xs">
          <div className="flex justify-between gap-2">
            <span className="text-gray-400 shrink-0">Pair</span>
            <span className="flex items-center gap-1 min-w-0 justify-end">
              <code className="text-[11px] text-gray-700 font-mono truncate max-w-[180px]">
                {shortenAddress(snapshot.pair.toBase58())}
              </code>
              <button
                type="button"
                className="text-gray-400 hover:text-gray-600 shrink-0"
                aria-label="Copy pair address"
                onClick={() => copyText("Pair", snapshot.pair.toBase58())}
              >
                <Copy size={12} />
              </button>
            </span>
          </div>
          <div className="flex justify-between gap-2">
            <span className="text-gray-400 shrink-0">LP mint</span>
            <span className="flex items-center gap-1 min-w-0 justify-end">
              <code className="text-[11px] text-gray-700 font-mono truncate max-w-[180px]">
                {shortenAddress(snapshot.lpMint.toBase58())}
              </code>
              <button
                type="button"
                className="text-gray-400 hover:text-gray-600 shrink-0"
                aria-label="Copy LP mint"
                onClick={() => copyText("LP mint", snapshot.lpMint.toBase58())}
              >
                <Copy size={12} />
              </button>
            </span>
          </div>
          <div className="flex justify-between gap-2">
            <span className="text-gray-400">{ticker} reserve</span>
            <span className="font-semibold text-gray-800 tabular-nums text-right">
              {formatNumber(
                Number(snapshot.reserveProjectRaw) /
                  10 ** snapshot.projectTokenDecimals
              )}
            </span>
          </div>
          <div className="flex justify-between gap-2">
            <span className="text-gray-400">SOL reserve</span>
            <span className="font-semibold text-gray-800 tabular-nums text-right">
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
            <span className="text-gray-400">Your LP</span>
            <span className="font-medium text-gray-700 tabular-nums text-right">
              {formatNumber(
                Number(snapshot.walletLpBalanceRaw) / 10 ** snapshot.lpDecimals
              )}
            </span>
          </div>
          <div className="flex justify-between gap-2 pt-1 border-t border-gray-100">
            <span className="text-gray-400">Spot (pool)</span>
            <span className="font-medium text-gray-800 tabular-nums">
              {snapshot.spotPriceSol > 0
                ? `${snapshot.spotPriceSol.toExponential(4)} SOL / ${ticker}`
                : "—"}
            </span>
          </div>
          <a
            href={`https://solscan.io/account/${snapshot.pair.toBase58()}?cluster=devnet`}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-[11px] font-medium text-amber-700 hover:text-amber-900 pt-1"
          >
            View pair on Solscan <ArrowUpRight size={11} />
          </a>
        </div>
      ) : !error && !loading ? (
        <p className="text-xs text-gray-500">No snapshot yet.</p>
      ) : null}
    </div>
  );
}
