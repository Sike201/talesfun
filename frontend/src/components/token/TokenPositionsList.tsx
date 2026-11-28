"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import type { Transaction } from "@solana/web3.js";
import { NATIVE_MINT } from "@solana/spl-token";
import { ChevronDown } from "lucide-react";
import toast from "react-hot-toast";
import type { Trade } from "@/types";
import { cn, formatNumber, formatUSD, shortenAddress } from "@/lib/utils";
import {
  dismissOpenPosition,
  listOpenPositions,
  type OpenLeveragePosition,
} from "@/lib/openPositions";
import type { OmnipairPoolSnapshot } from "@/lib/omnipairPoolState";
import {
  fetchOmnipairUserPosition,
  sendOmnipairAdjustPositionTx,
  sendOmnipairClosePositionTx,
  type OmnipairUserPositionView,
} from "@/lib/omnipairLending";
import {
  riskFromOnChainPosition,
  tradeExposureUsd,
  tradePnlUsd,
} from "@/lib/positionMetrics";
import { FieldHint, LabelWithHint } from "@/components/ui/FieldHint";

type Props = {
  mint: string;
  ticker?: string;
  imageUrl?: string | null;
  trades?: Trade[];
  spotSol: number;
  solUsd: number | null;
  connectedWallet?: string | null;
  omnipairPoolSnapshot?: OmnipairPoolSnapshot | null;
  onCountChange?: (count: number) => void;
};

const SOL_ICON = "/icons/sol.svg?v=2";

function ToLiqRing({ pct }: { pct: number }) {
  const r = 7;
  const c = 2 * Math.PI * r;
  const clamped = Math.max(0, Math.min(100, pct));
  const offset = c * (1 - clamped / 100);
  const tone =
    clamped < 15
      ? "stroke-red-400"
      : clamped < 40
        ? "stroke-amber-400"
        : "stroke-emerald-400";
  return (
    <span className="inline-flex items-center gap-1.5 tabular-nums">
      <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden>
        <circle
          cx="9"
          cy="9"
          r={r}
          fill="none"
          stroke="rgba(255,255,255,0.08)"
          strokeWidth="2.5"
        />
        <circle
          cx="9"
          cy="9"
          r={r}
          fill="none"
          className={tone}
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={offset}
          transform="rotate(-90 9 9)"
        />
      </svg>
      <span className="text-[12px] text-white/75">{clamped.toFixed(0)}%</span>
    </span>
  );
}

function TokenAvatar({
  src,
  fallback,
}: {
  src?: string | null;
  fallback: string;
}) {
  return (
    <span className="relative size-5 shrink-0 overflow-hidden rounded-full bg-white/10">
      {src?.trim() ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={src} alt="" width={20} height={20} className="size-5 object-cover" />
      ) : (
        <span className="flex size-5 items-center justify-center text-[8px] font-bold text-white/45">
          {fallback.slice(0, 2).toUpperCase()}
        </span>
      )}
    </span>
  );
}

function MetaCell({ label, hint, value }: { label: string; hint?: string; value: ReactNode }) {
  return (
    <div className="min-w-0">
      <p className="mb-0.5 inline-flex items-center gap-1 text-[10px] text-white/30">
        {label}
        {hint ? <FieldHint text={hint} /> : null}
      </p>
      <p className="truncate text-[12px] tabular-nums text-white/70">{value}</p>
    </div>
  );
}

export default function TokenPositionsList({
  mint,
  ticker = "TOKEN",
  imageUrl = null,
  trades = [],
  spotSol,
  solUsd,
  connectedWallet,
  omnipairPoolSnapshot = null,
  onCountChange,
}: Props) {
  const { connection } = useConnection();
  const walletAdapter = useWallet();
  const [tradesOpen, setTradesOpen] = useState(true);
  const [local, setLocal] = useState<OpenLeveragePosition[]>([]);
  const [onChain, setOnChain] = useState<OmnipairUserPositionView | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [loadingChain, setLoadingChain] = useState(false);

  const usd = solUsd ?? 140;
  const projectIcon = imageUrl?.trim() || null;

  const refresh = useCallback(async () => {
    if (!connectedWallet) {
      setLocal([]);
      setOnChain(null);
      onCountChange?.(0);
      return;
    }
    const mine = listOpenPositions(mint).filter(
      p => p.wallet.toLowerCase() === connectedWallet.toLowerCase()
    );
    setLocal(mine);

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
        const pos = await fetchOmnipairUserPosition({
          connection,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          wallet: wallet as any,
          snapshot: omnipairPoolSnapshot,
        });
        const live =
          pos &&
          (pos.collateral0 > BigInt(0) ||
            pos.collateral1 > BigInt(0) ||
            pos.debt0Raw > BigInt(0) ||
            pos.debt1Raw > BigInt(0))
            ? pos
            : null;
        setOnChain(live);
      } catch {
        setOnChain(null);
      } finally {
        setLoadingChain(false);
      }
    } else {
      setOnChain(null);
    }
  }, [
    connectedWallet,
    mint,
    omnipairPoolSnapshot,
    connection,
    walletAdapter,
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

  const tradeRows = useMemo(
    () => local.filter(p => (p.kind ?? "trade") === "trade"),
    [local]
  );
  const loanRows = useMemo(
    () => local.filter(p => p.kind === "loan"),
    [local]
  );

  const risk = useMemo(() => {
    if (!onChain || !omnipairPoolSnapshot || !(spotSol > 0)) return null;
    return riskFromOnChainPosition({
      pos: onChain,
      projectMint: omnipairPoolSnapshot.projectMint,
      projectDecimals: omnipairPoolSnapshot.projectTokenDecimals,
      spotSol,
      solUsd: usd,
    });
  }, [onChain, omnipairPoolSnapshot, spotSol, usd]);

  const displayTrades = useMemo(() => {
    if (tradeRows.length > 0) return tradeRows;
    if (!onChain || !omnipairPoolSnapshot || !connectedWallet) return [];
    const projectIs0 = onChain.token0.equals(omnipairPoolSnapshot.projectMint);
    const debtProject = projectIs0 ? onChain.debt0Raw : onChain.debt1Raw;
    const collSol = NATIVE_MINT.equals(onChain.token0)
      ? onChain.collateral0
      : onChain.collateral1;
    const debtSol = NATIVE_MINT.equals(onChain.token0)
      ? onChain.debt0Raw
      : onChain.debt1Raw;
    const isShort = debtProject > BigInt(0);
    const isLongLev =
      !isShort && debtSol > BigInt(0) && collSol === BigInt(0);
    if (!isShort && !isLongLev) return [];
    return [
      {
        id: "onchain-trade",
        mint,
        wallet: connectedWallet,
        kind: "trade" as const,
        direction: (isShort ? "short" : "long") as "long" | "short",
        leverage: 0,
        marginUi: 0,
        entrySpotSol: spotSol,
        entrySolUsd: usd,
        signature: "",
        openedAt: new Date().toISOString(),
      },
    ];
  }, [
    tradeRows,
    onChain,
    omnipairPoolSnapshot,
    connectedWallet,
    mint,
    spotSol,
    usd,
  ]);

  const displayLoans = useMemo(() => {
    if (loanRows.length > 0) return loanRows;
    if (!onChain || !omnipairPoolSnapshot || !connectedWallet) return [];
    if (tradeRows.length > 0) return [];
    const projectIs0 = onChain.token0.equals(omnipairPoolSnapshot.projectMint);
    const collProject = projectIs0 ? onChain.collateral0 : onChain.collateral1;
    const debtSol = NATIVE_MINT.equals(onChain.token0)
      ? onChain.debt0Raw
      : onChain.debt1Raw;
    const debtProject = projectIs0 ? onChain.debt0Raw : onChain.debt1Raw;
    if (!(collProject > BigInt(0) && debtSol > BigInt(0) && debtProject === BigInt(0))) {
      return [];
    }
    return [
      {
        id: "onchain-loan",
        mint,
        wallet: connectedWallet,
        kind: "loan" as const,
        direction: "long" as const,
        leverage: 0,
        marginUi:
          Number(collProject) /
          10 ** omnipairPoolSnapshot.projectTokenDecimals,
        entrySpotSol: spotSol,
        entrySolUsd: usd,
        signature: "",
        openedAt: new Date().toISOString(),
        borrowSolUi: Number(debtSol) / 1e9,
      },
    ];
  }, [
    loanRows,
    tradeRows.length,
    onChain,
    omnipairPoolSnapshot,
    connectedWallet,
    mint,
    spotSol,
    usd,
  ]);

  const openCount = displayTrades.length + displayLoans.length;

  useEffect(() => {
    onCountChange?.(openCount);
  }, [openCount, onCountChange]);

  const mySwaps = useMemo(() => {
    if (!connectedWallet) return [];
    return trades
      .filter(
        t =>
          t.trader?.toLowerCase() === connectedWallet.toLowerCase() &&
          (t.type === "buy" ||
            t.type === "sell" ||
            t.type === "long" ||
            t.type === "short" ||
            t.type === "borrow")
      )
      .slice(0, 50);
  }, [trades, connectedWallet]);

  const tradesSummary = useMemo(() => {
    let value = 0;
    let pnl = 0;
    let exposure = 0;
    for (const p of displayTrades) {
      const { markUsd, pnlUsd } = tradePnlUsd(p, spotSol);
      value += markUsd;
      pnl += pnlUsd;
      exposure += tradeExposureUsd(p);
    }
    for (const p of displayLoans) {
      value +=
        risk?.collateralUsd ??
        p.marginUi * (p.entrySpotSol || spotSol) * usd;
      exposure += (p.borrowSolUi ?? 0) * usd;
    }
    if (risk && displayTrades.length > 0 && value <= 0) {
      value = Math.max(0, risk.collateralUsd - risk.debtUsd);
    }
    return { value, pnl, exposure };
  }, [displayTrades, displayLoans, spotSol, risk, usd]);

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
        direction: p.kind === "loan" ? "borrow" : p.direction,
      });
      dismissOpenPosition(p.id);
      toast.success(`Closed (${sigs.length} tx)`);
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

  const onRepay = async (p: OpenLeveragePosition) => {
    if (!omnipairPoolSnapshot) return;
    const wallet = anchorWallet();
    if (!wallet) return;
    setBusyId(p.id);
    try {
      await sendOmnipairAdjustPositionTx({
        connection,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        wallet: wallet as any,
        snapshot: omnipairPoolSnapshot,
        repayMint:
          p.direction === "short"
            ? omnipairPoolSnapshot.projectMint
            : NATIVE_MINT,
        repayAll: true,
      });
      toast.success("Debt repaid");
      await refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Repay failed");
    } finally {
      setBusyId(null);
    }
  };

  const onWithdraw = async (p: OpenLeveragePosition) => {
    if (!omnipairPoolSnapshot) return;
    const wallet = anchorWallet();
    if (!wallet) return;
    setBusyId(p.id);
    try {
      await sendOmnipairAdjustPositionTx({
        connection,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        wallet: wallet as any,
        snapshot: omnipairPoolSnapshot,
        removeCollateralMint:
          p.direction === "short"
            ? NATIVE_MINT
            : omnipairPoolSnapshot.projectMint,
        removeAll: true,
      });
      dismissOpenPosition(p.id);
      toast.success("Collateral withdrawn");
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
        Connect your wallet to see open trades and your swap history.
      </p>
    );
  }

  const renderTradeRow = (p: OpenLeveragePosition) => {
    const localMark = tradePnlUsd(p, spotSol);
    const markUsd =
      localMark.markUsd > 0
        ? localMark.markUsd
        : risk
          ? Math.max(0, risk.collateralUsd - risk.debtUsd)
          : 0;
    const pnlUsd = localMark.markUsd > 0 ? localMark.pnlUsd : 0;
    const toLiq = risk?.toLiquidationPct ?? 100;
    const expanded = expandedId === p.id;
    const busy = busyId === p.id;
    const sideLabel = p.direction === "long" ? "Long" : "Short";
    const lev =
      p.leverage > 0 ? `${p.leverage.toFixed(1)}x ` : "";

    return (
      <div key={p.id} className="rounded-xl bg-white/[0.025]">
        <button
          type="button"
          className="grid w-full grid-cols-[1fr_auto] items-center gap-2 px-3 py-3 text-left sm:grid-cols-[minmax(0,1.5fr)_88px_72px_72px_20px]"
          onClick={() => setExpandedId(expanded ? null : p.id)}
        >
          <span className="flex min-w-0 items-center gap-2">
            <TokenAvatar src={projectIcon} fallback={ticker} />
            <span className="truncate text-[13px] font-medium text-white/90">
              {lev}
              {sideLabel} {ticker}
            </span>
          </span>
          <span className="hidden sm:inline-flex">
            <ToLiqRing pct={toLiq} />
          </span>
          <span
            className={cn(
              "hidden text-right text-[12px] font-semibold tabular-nums sm:block",
              pnlUsd >= 0 ? "text-emerald-400" : "text-red-400"
            )}
          >
            {pnlUsd >= 0 ? "+" : ""}
            {formatUSD(pnlUsd)}
          </span>
          <span className="text-right text-[12px] tabular-nums text-white/70">
            {markUsd > 0 ? formatUSD(markUsd) : "—"}
          </span>
          <ChevronDown
            size={14}
            className={cn(
              "justify-self-end text-white/30 transition-transform",
              expanded && "rotate-180"
            )}
          />
        </button>
        {expanded ? (
          <div className="space-y-3 px-3 pb-3">
            <div className="flex flex-wrap items-center gap-2 text-[12px]">
              <span
                className={cn(
                  "font-medium",
                  risk?.riskLabel === "High risk"
                    ? "text-red-400"
                    : risk?.riskLabel === "Medium risk"
                      ? "text-amber-300"
                      : "text-emerald-400"
                )}
              >
                {risk?.riskLabel ?? "—"}
              </span>
              {risk?.liquidationSpotSol != null ? (
                <span className="text-white/40">
                  Liquidates at $
                  {(risk.liquidationSpotSol * usd).toPrecision(3)} per {ticker}
                </span>
              ) : null}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                disabled={busy || !omnipairPoolSnapshot}
                className="rounded-lg bg-white px-3.5 py-1.5 text-[11px] font-semibold text-black hover:brightness-95 disabled:opacity-40"
                onClick={() => void onClose(p)}
              >
                {busy ? "Closing…" : "Market close"}
              </button>
              <button
                type="button"
                disabled={busy || !omnipairPoolSnapshot}
                className="rounded-lg px-2.5 py-1.5 text-[11px] font-medium text-white/45 hover:bg-white/[0.06] hover:text-white/75 disabled:opacity-40"
                onClick={() => void onRepay(p)}
              >
                Repay only
              </button>
              <button
                type="button"
                disabled={busy || !omnipairPoolSnapshot}
                className="rounded-lg px-2.5 py-1.5 text-[11px] font-medium text-white/45 hover:bg-white/[0.06] hover:text-white/75 disabled:opacity-40"
                onClick={() => void onWithdraw(p)}
              >
                Withdraw only
              </button>
            </div>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <MetaCell
                label="Entry"
                value={
                  p.entrySpotSol > 0
                    ? `$${(p.entrySpotSol * p.entrySolUsd).toPrecision(4)}`
                    : "—"
                }
              />
              <MetaCell
                label="Mark"
                value={spotSol > 0 ? `$${(spotSol * usd).toPrecision(4)}` : "—"}
              />
              <MetaCell
                label="LTV"
                hint="Loan-to-value: debt divided by collateral. Rising LTV means less room before liquidation."
                value={risk ? `${(risk.ltv * 100).toFixed(1)}%` : "—"}
              />
              <MetaCell
                label="To liq"
                hint="Headroom left before liquidation. Near 0% means the position is at high risk."
                value={risk ? `${risk.toLiquidationPct.toFixed(1)}%` : "—"}
              />
            </div>
          </div>
        ) : null}
      </div>
    );
  };

  const renderLoanRow = (p: OpenLeveragePosition) => {
    const toLiq = risk?.toLiquidationPct ?? 100;
    const owes = risk?.debtUsd ?? (p.borrowSolUi ?? 0) * usd;
    const value =
      risk?.collateralUsd ?? p.marginUi * (p.entrySpotSol || spotSol) * usd;
    const expanded = expandedId === p.id;
    const busy = busyId === p.id;
    const borrowedSol = p.borrowSolUi ?? (risk ? risk.debtUsd / usd : 0);

    return (
      <div key={p.id} className="rounded-xl bg-white/[0.025]">
        <button
          type="button"
          className="grid w-full grid-cols-[1fr_auto] items-center gap-2 px-3 py-3 text-left sm:grid-cols-[minmax(0,1.4fr)_88px_72px_72px_20px]"
          onClick={() => setExpandedId(expanded ? null : p.id)}
        >
          <span className="flex min-w-0 items-center gap-2">
            <TokenAvatar src={SOL_ICON} fallback="SOL" />
            <span className="truncate text-[13px] font-medium text-white/90">
              Borrow {borrowedSol > 0 ? borrowedSol.toFixed(3) : "—"} SOL
            </span>
          </span>
          <span className="hidden sm:inline-flex">
            <ToLiqRing pct={toLiq} />
          </span>
          <span className="text-right text-[12px] tabular-nums text-white/55">
            Owes {formatUSD(owes)}
          </span>
          <span className="hidden text-right text-[12px] tabular-nums text-white/70 sm:block">
            {formatUSD(value)}
          </span>
          <ChevronDown
            size={14}
            className={cn(
              "justify-self-end text-white/30 transition-transform",
              expanded && "rotate-180"
            )}
          />
        </button>
        {expanded ? (
          <div className="space-y-3 px-3 pb-3">
            <div className="flex flex-wrap items-center gap-2 text-[12px]">
              <span
                className={cn(
                  "font-medium",
                  risk?.riskLabel === "High risk"
                    ? "text-red-400"
                    : risk?.riskLabel === "Medium risk"
                      ? "text-amber-300"
                      : "text-emerald-400"
                )}
              >
                {risk?.riskLabel ?? "Low risk"}
              </span>
              {risk?.liquidationSpotSol != null ? (
                <span className="text-white/40">
                  Liquidates at $
                  {(risk.liquidationSpotSol * usd).toPrecision(3)} per {ticker}
                </span>
              ) : null}
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                disabled={busy || !omnipairPoolSnapshot}
                className="rounded-lg bg-white/[0.06] px-3 py-1.5 text-[11px] font-medium text-white/80 hover:bg-white/[0.1] disabled:opacity-40"
                onClick={() => void onRepay(p)}
              >
                Repay
              </button>
              <button
                type="button"
                disabled={busy || !omnipairPoolSnapshot}
                className="rounded-lg bg-white/[0.06] px-3 py-1.5 text-[11px] font-medium text-white/80 hover:bg-white/[0.1] disabled:opacity-40"
                onClick={() => void onWithdraw(p)}
              >
                Withdraw collateral
              </button>
              <button
                type="button"
                disabled={busy || !omnipairPoolSnapshot}
                className="rounded-lg bg-white/[0.06] px-3 py-1.5 text-[11px] font-medium text-white/80 hover:bg-white/[0.1] disabled:opacity-40"
                onClick={() => void onClose(p)}
              >
                {busy ? "Closing…" : "Close loan"}
              </button>
            </div>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <MetaCell
                label="Collateral"
                value={`${formatNumber(p.marginUi)} ${ticker}`}
              />
              <MetaCell
                label="Debt"
                value={`${borrowedSol.toFixed(4)} SOL`}
              />
              <MetaCell
                label="LTV"
                hint="Debt ÷ collateral. Stay below the pool liquidation threshold."
                value={
                  risk
                    ? `${(risk.ltv * 100).toFixed(1)}% · ${(risk.liquidationLtv * 100).toFixed(0)}% max`
                    : "—"
                }
              />
              <MetaCell label="Collateral $" value={formatUSD(value)} />
            </div>
          </div>
        ) : null}
      </div>
    );
  };

  const historyLabel = (t: Trade) => {
    if (t.type === "buy") return "Buy";
    if (t.type === "sell") return "Sell";
    if (t.type === "long") return "Long";
    if (t.type === "short") return "Short";
    if (t.type === "borrow") return "Borrow";
    return t.type;
  };

  return (
    <div className="space-y-5 px-0.5 py-2">
      {loadingChain ? (
        <p className="px-1 text-[11px] text-white/30">Syncing on-chain position…</p>
      ) : null}

      {/* Single collapsible: Trades (leverage + loans) */}
      <div>
        <button
          type="button"
          onClick={() => setTradesOpen(v => !v)}
          className="flex w-full items-start gap-3 text-left"
        >
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="text-[15px] font-semibold text-white">Trades</span>
              <span className="text-[12px] tabular-nums text-white/35">
                {openCount}
              </span>
              <FieldHint text="Open leverage longs/shorts from the Leverage tab. Market close unwinds debt + collateral in one flow; repay/withdraw are advanced." />
            </div>
            <div className="mt-2 flex flex-wrap items-baseline gap-x-4 gap-y-1 text-[12px]">
              <span className="text-[20px] font-semibold tabular-nums text-white">
                {formatUSD(tradesSummary.value)}
              </span>
              <span
                className={cn(
                  "tabular-nums",
                  tradesSummary.pnl >= 0 ? "text-emerald-400" : "text-red-400"
                )}
              >
                PnL {tradesSummary.pnl >= 0 ? "+" : ""}
                {formatUSD(tradesSummary.pnl)}
              </span>
              <span className="inline-flex items-center gap-1 text-white/40">
                Exposure {formatUSD(tradesSummary.exposure)}
                <FieldHint text="Notional size at risk — margin × leverage for trades, or outstanding SOL debt for borrows." />
              </span>
            </div>
          </div>
          <ChevronDown
            size={16}
            className={cn(
              "mt-1 shrink-0 text-white/35 transition-transform",
              tradesOpen && "rotate-180"
            )}
          />
        </button>

        {tradesOpen ? (
          <div className="mt-3 space-y-2">
            {openCount === 0 ? (
              <p className="py-8 text-center text-[12px] text-white/35">
                No open positions. Use Leverage or Borrow to open one.
              </p>
            ) : (
              <>
                {displayTrades.map(renderTradeRow)}
                {displayLoans.map(renderLoanRow)}
              </>
            )}
          </div>
        ) : null}
      </div>

      {/* Flat history — not a second accordion */}
      <div>
        <div className="mb-2 flex items-baseline justify-between gap-2">
          <p className="text-[13px] font-medium text-white/55">
            <LabelWithHint hint="Your buys, sells, leverage opens, and borrows for this token from the connected wallet.">
              History
            </LabelWithHint>
          </p>
          <span className="text-[11px] tabular-nums text-white/30">
            {mySwaps.length}
          </span>
        </div>

        {mySwaps.length === 0 ? (
          <p className="py-6 text-center text-[12px] text-white/35">
            No swaps yet from this wallet.
          </p>
        ) : (
          <div className="max-h-[320px] space-y-0.5 overflow-y-auto scrollbar-hide">
            {mySwaps.map(t => {
              const usdVal =
                t.solAmount > 0 && usd > 0 ? t.solAmount * usd : null;
              const actionTone =
                t.type === "buy" || t.type === "long"
                  ? "text-emerald-400"
                  : t.type === "sell" || t.type === "short"
                    ? "text-red-400"
                    : "text-sky-300";
              return (
                <div
                  key={t.id || t.txSignature}
                  className="grid grid-cols-[3.2rem_1fr_auto] items-center gap-2 rounded-lg px-1 py-2.5 text-[12px] hover:bg-white/[0.03] sm:grid-cols-[3.5rem_minmax(0,1fr)_5.5rem_5rem_4.5rem]"
                >
                  <span className={cn("font-semibold", actionTone)}>
                    {historyLabel(t)}
                  </span>
                  <span className="min-w-0 truncate tabular-nums text-white/80">
                    {t.tokenAmount > 0 ? (
                      <>
                        {formatNumber(t.tokenAmount)}{" "}
                        <span className="text-white/45">{ticker}</span>
                      </>
                    ) : t.type === "borrow" && t.solAmount > 0 ? (
                      <>
                        {t.solAmount.toFixed(4)}{" "}
                        <span className="text-white/45">SOL</span>
                      </>
                    ) : (
                      "—"
                    )}
                  </span>
                  <span className="hidden tabular-nums text-white/55 sm:block">
                    {t.solAmount > 0 ? `${t.solAmount.toFixed(4)} SOL` : "—"}
                  </span>
                  <span className="text-right tabular-nums text-white/70">
                    {usdVal != null
                      ? usdVal >= 0.01
                        ? formatUSD(usdVal)
                        : `$${usdVal.toFixed(4)}`
                      : "—"}
                  </span>
                  {t.txSignature ? (
                    <a
                      href={`https://solscan.io/tx/${t.txSignature}?cluster=devnet`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="hidden justify-self-end font-mono text-[10px] text-white/30 hover:text-white/60 sm:block"
                      title={t.txSignature}
                    >
                      {shortenAddress(t.txSignature, 4)}
                    </a>
                  ) : (
                    <span className="hidden sm:block" />
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
