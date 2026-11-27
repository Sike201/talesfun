"use client";

import { useEffect, useMemo, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import type { Transaction } from "@solana/web3.js";
import { NATIVE_MINT } from "@solana/spl-token";
import toast from "react-hot-toast";
import type { Trade } from "@/types";
import { cn, formatUSD, shortenAddress } from "@/lib/utils";
import {
  dismissOpenPosition,
  listOpenPositions,
  markPositionValueUsd,
  type OpenLeveragePosition,
} from "@/lib/openPositions";
import type { OmnipairPoolSnapshot } from "@/lib/omnipairPoolState";
import {
  fetchOmnipairUserPosition,
  sendOmnipairAdjustPositionTx,
  sendOmnipairClosePositionTx,
} from "@/lib/omnipairLending";

type Props = {
  mint: string;
  trades: Trade[];
  spotSol: number;
  solUsd: number | null;
  connectedWallet?: string | null;
  omnipairPoolSnapshot?: OmnipairPoolSnapshot | null;
};

function fromTrades(trades: Trade[], mint: string): OpenLeveragePosition[] {
  const out: OpenLeveragePosition[] = [];
  const seen = new Set<string>();
  for (const t of trades) {
    if (t.type !== "long" && t.type !== "short" && t.type !== "borrow") continue;
    const direction = t.type === "borrow" ? "long" : t.type;
    const key = `${t.trader}:${direction}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      id: t.txSignature || `${t.trader}-${direction}`,
      mint,
      wallet: t.trader,
      direction,
      leverage: 0,
      marginUi: direction === "short" ? t.solAmount : t.tokenAmount,
      entrySpotSol: t.price > 0 ? t.price : 0,
      entrySolUsd: 0,
      signature: t.txSignature,
      openedAt:
        t.timestamp instanceof Date
          ? t.timestamp.toISOString()
          : new Date(t.timestamp).toISOString(),
    });
  }
  return out;
}

export default function TokenPositionsList({
  mint,
  trades,
  spotSol,
  solUsd,
  connectedWallet,
  omnipairPoolSnapshot = null,
}: Props) {
  const { connection } = useConnection();
  const walletAdapter = useWallet();
  const [local, setLocal] = useState<OpenLeveragePosition[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [adjustId, setAdjustId] = useState<string | null>(null);

  useEffect(() => {
    const refresh = () => setLocal(listOpenPositions(mint));
    refresh();
    const onChange = () => refresh();
    window.addEventListener("higher:positions-changed", onChange);
    window.addEventListener("storage", onChange);
    return () => {
      window.removeEventListener("higher:positions-changed", onChange);
      window.removeEventListener("storage", onChange);
    };
  }, [mint]);

  const rows = useMemo(() => {
    const fromActivity = fromTrades(trades, mint);
    const byKey = new Map<string, OpenLeveragePosition>();
    for (const p of fromActivity) byKey.set(`${p.wallet}:${p.direction}`, p);
    for (const p of local) byKey.set(`${p.wallet}:${p.direction}`, p);
    return Array.from(byKey.values()).sort(
      (a, b) => +new Date(b.openedAt) - +new Date(a.openedAt)
    );
  }, [trades, mint, local]);

  const anchorWallet = () => {
    if (!walletAdapter.publicKey || !walletAdapter.signTransaction) return null;
    return {
      publicKey: walletAdapter.publicKey,
      signTransaction: walletAdapter.signTransaction.bind(walletAdapter),
      signAllTransactions:
        walletAdapter.signAllTransactions?.bind(walletAdapter) ??
        (async (txs: Transaction[]) => {
          const out: Transaction[] = [];
          for (const t of txs) {
            out.push(await walletAdapter.signTransaction!(t));
          }
          return out;
        }),
    };
  };

  const onClose = async (p: OpenLeveragePosition) => {
    if (!omnipairPoolSnapshot) {
      toast.error("Pool not ready");
      return;
    }
    const wallet = anchorWallet();
    if (!wallet) {
      toast.error("Connect a signing wallet");
      return;
    }
    setBusyId(p.id);
    try {
      const { sigs } = await sendOmnipairClosePositionTx({
        connection,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        wallet: wallet as any,
        snapshot: omnipairPoolSnapshot,
        direction: p.direction,
      });
      dismissOpenPosition(p.id);
      toast.success(`Position closed (${sigs.length} tx${sigs.length === 1 ? "" : "s"})`);
      window.dispatchEvent(
        new CustomEvent("higher:trade-complete", {
          detail: { mint, source: "omnipair" },
        })
      );
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Close failed");
    } finally {
      setBusyId(null);
    }
  };

  const onAdjustRepayAll = async (p: OpenLeveragePosition) => {
    if (!omnipairPoolSnapshot) {
      toast.error("Pool not ready");
      return;
    }
    const wallet = anchorWallet();
    if (!wallet) {
      toast.error("Connect a signing wallet");
      return;
    }
    setBusyId(p.id);
    try {
      const pos = await fetchOmnipairUserPosition({
        connection,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        wallet: wallet as any,
        snapshot: omnipairPoolSnapshot,
      });
      if (!pos) throw new Error("No on-chain position");
      const repayMint =
        p.direction === "short" ? omnipairPoolSnapshot.projectMint : NATIVE_MINT;
      await sendOmnipairAdjustPositionTx({
        connection,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        wallet: wallet as any,
        snapshot: omnipairPoolSnapshot,
        repayMint,
        repayAll: true,
      });
      toast.success("Debt repaid");
      setAdjustId(null);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Adjust failed");
    } finally {
      setBusyId(null);
    }
  };

  const onAdjustWithdrawAll = async (p: OpenLeveragePosition) => {
    if (!omnipairPoolSnapshot) {
      toast.error("Pool not ready");
      return;
    }
    const wallet = anchorWallet();
    if (!wallet) {
      toast.error("Connect a signing wallet");
      return;
    }
    setBusyId(p.id);
    try {
      const collMint =
        p.direction === "short"
          ? NATIVE_MINT
          : omnipairPoolSnapshot.projectMint;
      await sendOmnipairAdjustPositionTx({
        connection,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        wallet: wallet as any,
        snapshot: omnipairPoolSnapshot,
        removeCollateralMint: collMint,
        removeAll: true,
      });
      dismissOpenPosition(p.id);
      toast.success("Collateral withdrawn");
      setAdjustId(null);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Withdraw failed");
    } finally {
      setBusyId(null);
    }
  };

  if (rows.length === 0) {
    return (
      <p className="px-1 py-14 text-center text-sm text-white/40">
        No open long/short positions yet. Open one from Leverage.
      </p>
    );
  }

  const usd = solUsd ?? 140;

  return (
    <div className="token-activity-table-wrap">
      <div className="token-activity-cols hidden grid-cols-[1fr_70px_1fr_1fr] sm:grid sm:!grid-cols-[1fr_70px_90px_1fr]">
        <span>Trader</span>
        <span>Side</span>
        <span className="text-right">Leverage</span>
        <span className="text-right">Position value</span>
      </div>
      <div className="max-h-[420px] overflow-y-auto scrollbar-hide">
        {rows.map(p => {
          const hasMark = p.leverage > 0 && p.entrySpotSol > 0;
          const { entryUsd, markUsd } = hasMark
            ? markPositionValueUsd(p, spotSol)
            : {
                entryUsd: 0,
                markUsd:
                  p.direction === "long"
                    ? p.marginUi * (spotSol > 0 ? spotSol : 0) * usd
                    : p.marginUi * usd,
              };
          const underwater = hasMark && markUsd < entryUsd;
          const mine =
            connectedWallet &&
            p.wallet.toLowerCase() === connectedWallet.toLowerCase();
          const busy = busyId === p.id;
          const adjusting = adjustId === p.id;

          return (
            <div key={p.id} className="border-b border-white/[0.04] last:border-0">
              <div className="token-activity-row grid grid-cols-[1fr_auto] items-center gap-2 sm:grid-cols-[1fr_70px_90px_1fr]">
                <span className="flex min-w-0 items-center gap-2">
                  <a
                    href={`https://solscan.io/account/${p.wallet}?cluster=devnet`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="truncate font-mono text-[12px] text-white/70 hover:text-white"
                    title={p.wallet}
                  >
                    {mine ? "You" : shortenAddress(p.wallet)}
                  </a>
                </span>
                <span
                  className={cn(
                    "text-[11px] font-semibold uppercase tracking-wide",
                    p.direction === "long" ? "text-emerald-400" : "text-red-400"
                  )}
                >
                  {p.direction}
                </span>
                <span className="text-right tabular-nums text-white/75">
                  {p.leverage > 0 ? `${p.leverage.toFixed(1)}x` : "—"}
                  {p.leverage > 0 ? (
                    <span className="ml-1 text-[10px] text-white/35">locked</span>
                  ) : null}
                </span>
                <span className="flex items-center justify-end gap-2">
                  <span
                    className={cn(
                      "tabular-nums",
                      underwater ? "text-red-400" : "text-white/80"
                    )}
                  >
                    {markUsd > 0 ? formatUSD(markUsd) : "—"}
                  </span>
                  {mine ? (
                    <span className="flex items-center gap-1.5">
                      <button
                        type="button"
                        disabled={busy || !omnipairPoolSnapshot}
                        className="rounded-md bg-white/[0.08] px-2 py-0.5 text-[10px] font-semibold text-white/80 transition-colors hover:bg-white/[0.14] disabled:opacity-40"
                        onClick={() => void onClose(p)}
                      >
                        {busy && !adjusting ? "Closing…" : "Close"}
                      </button>
                      <button
                        type="button"
                        disabled={busy || !omnipairPoolSnapshot}
                        className="rounded-md px-1.5 py-0.5 text-[10px] font-medium text-white/45 hover:text-white/75 disabled:opacity-40"
                        onClick={() =>
                          setAdjustId(adjusting ? null : p.id)
                        }
                      >
                        Adjust
                      </button>
                    </span>
                  ) : null}
                </span>
              </div>
              {mine && adjusting ? (
                <div className="flex flex-wrap items-center gap-2 px-3 pb-3">
                  <button
                    type="button"
                    disabled={busy}
                    className="rounded-md border border-white/10 px-2.5 py-1 text-[11px] text-white/70 hover:bg-white/[0.06] disabled:opacity-40"
                    onClick={() => void onAdjustRepayAll(p)}
                  >
                    Repay debt
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    className="rounded-md border border-white/10 px-2.5 py-1 text-[11px] text-white/70 hover:bg-white/[0.06] disabled:opacity-40"
                    onClick={() => void onAdjustWithdrawAll(p)}
                  >
                    Withdraw collateral
                  </button>
                  <span className="text-[10px] text-white/30">
                    Repay first, then withdraw (Omnipair requires zero debt for full withdraw).
                  </span>
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}
