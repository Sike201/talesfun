"use client";

import { useCallback, useEffect, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import type { Transaction } from "@solana/web3.js";
import { NATIVE_MINT } from "@solana/spl-token";
import toast from "react-hot-toast";
import { cn, formatUSD } from "@/lib/utils";
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
  spotSol: number;
  solUsd: number | null;
  connectedWallet?: string | null;
  omnipairPoolSnapshot?: OmnipairPoolSnapshot | null;
  /** Notify parent of how many open positions the connected wallet has */
  onCountChange?: (count: number) => void;
};

function directionFromOnChain(
  pos: NonNullable<Awaited<ReturnType<typeof fetchOmnipairUserPosition>>>,
  projectMint: OmnipairPoolSnapshot["projectMint"]
): "long" | "short" {
  const projectIs0 = pos.token0.equals(projectMint);
  const debtProject = projectIs0 ? pos.debt0Raw : pos.debt1Raw;
  const debtSol = NATIVE_MINT.equals(pos.token0) ? pos.debt0Raw : pos.debt1Raw;
  const collSol = NATIVE_MINT.equals(pos.token0)
    ? pos.collateral0
    : pos.collateral1;
  if (debtProject > BigInt(0) || (collSol > BigInt(0) && debtSol === BigInt(0))) {
    return "short";
  }
  return "long";
}

export default function TokenPositionsList({
  mint,
  spotSol,
  solUsd,
  connectedWallet,
  omnipairPoolSnapshot = null,
  onCountChange,
}: Props) {
  const { connection } = useConnection();
  const walletAdapter = useWallet();
  const [rows, setRows] = useState<OpenLeveragePosition[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [adjustId, setAdjustId] = useState<string | null>(null);
  const [loadingChain, setLoadingChain] = useState(false);

  const refresh = useCallback(async () => {
    if (!connectedWallet) {
      setRows([]);
      onCountChange?.(0);
      return;
    }

    const local = listOpenPositions(mint).filter(
      p => p.wallet.toLowerCase() === connectedWallet.toLowerCase()
    );
    const byKey = new Map<string, OpenLeveragePosition>();
    for (const p of local) byKey.set(p.direction, p);

    if (
      omnipairPoolSnapshot &&
      walletAdapter.publicKey &&
      walletAdapter.signTransaction
    ) {
      setLoadingChain(true);
      try {
        const wallet = {
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
        const onChain = await fetchOmnipairUserPosition({
          connection,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          wallet: wallet as any,
          snapshot: omnipairPoolSnapshot,
        });
        if (
          onChain &&
          (onChain.collateral0 > BigInt(0) ||
            onChain.collateral1 > BigInt(0) ||
            onChain.debt0Raw > BigInt(0) ||
            onChain.debt1Raw > BigInt(0))
        ) {
          const direction = directionFromOnChain(
            onChain,
            omnipairPoolSnapshot.projectMint
          );
          const existing = byKey.get(direction);
          const projectIs0 = onChain.token0.equals(
            omnipairPoolSnapshot.projectMint
          );
          const collProject = projectIs0
            ? onChain.collateral0
            : onChain.collateral1;
          const collSol = NATIVE_MINT.equals(onChain.token0)
            ? onChain.collateral0
            : onChain.collateral1;
          const marginUi =
            direction === "short"
              ? Number(collSol) / 1e9
              : Number(collProject) /
                10 ** omnipairPoolSnapshot.projectTokenDecimals;

          byKey.set(direction, {
            id: existing?.id ?? `onchain-${direction}`,
            mint,
            wallet: connectedWallet,
            direction,
            leverage: existing?.leverage ?? 0,
            marginUi: marginUi > 0 ? marginUi : existing?.marginUi ?? 0,
            entrySpotSol: existing?.entrySpotSol ?? spotSol,
            entrySolUsd: existing?.entrySolUsd ?? (solUsd ?? 0),
            signature: existing?.signature ?? "",
            openedAt: existing?.openedAt ?? new Date().toISOString(),
          });
        }
      } catch {
        /* local rows still fine */
      } finally {
        setLoadingChain(false);
      }
    }

    const next = Array.from(byKey.values()).sort(
      (a, b) => +new Date(b.openedAt) - +new Date(a.openedAt)
    );
    setRows(next);
    onCountChange?.(next.length);
  }, [
    connectedWallet,
    mint,
    omnipairPoolSnapshot,
    connection,
    walletAdapter,
    spotSol,
    solUsd,
    onCountChange,
  ]);

  useEffect(() => {
    void refresh();
    const onChange = () => void refresh();
    window.addEventListener("higher:positions-changed", onChange);
    window.addEventListener("storage", onChange);
    window.addEventListener("higher:trade-complete", onChange);
    return () => {
      window.removeEventListener("higher:positions-changed", onChange);
      window.removeEventListener("storage", onChange);
      window.removeEventListener("higher:trade-complete", onChange);
    };
  }, [refresh]);

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
      await refresh();
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
      await refresh();
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
      await refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Withdraw failed");
    } finally {
      setBusyId(null);
    }
  };

  if (!connectedWallet) {
    return (
      <p className="px-1 py-14 text-center text-sm text-white/40">
        Connect your wallet to see your leverage and borrow positions.
      </p>
    );
  }

  if (rows.length === 0) {
    return (
      <p className="px-1 py-14 text-center text-sm text-white/40">
        {loadingChain
          ? "Loading your positions…"
          : "No open positions. Open one from Leverage or Borrow."}
      </p>
    );
  }

  const usd = solUsd ?? 140;

  return (
    <div className="token-activity-table-wrap">
      <div className="token-activity-cols hidden grid-cols-[70px_1fr_1fr_auto] sm:grid sm:!grid-cols-[70px_90px_1fr_auto]">
        <span>Side</span>
        <span className="text-right">Leverage</span>
        <span className="text-right">Position value</span>
        <span className="text-right">Actions</span>
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
          const busy = busyId === p.id;
          const adjusting = adjustId === p.id;

          return (
            <div key={p.id} className="border-b border-white/[0.04] last:border-0">
              <div className="token-activity-row grid grid-cols-[70px_1fr_auto] items-center gap-2 sm:grid-cols-[70px_90px_1fr_auto]">
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
                <span
                  className={cn(
                    "text-right tabular-nums",
                    underwater ? "text-red-400" : "text-white/80"
                  )}
                >
                  {markUsd > 0 ? formatUSD(markUsd) : "—"}
                </span>
                <span className="flex items-center justify-end gap-1.5">
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
                    onClick={() => setAdjustId(adjusting ? null : p.id)}
                  >
                    Adjust
                  </button>
                </span>
              </div>
              {adjusting ? (
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
                    Repay first, then withdraw.
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
