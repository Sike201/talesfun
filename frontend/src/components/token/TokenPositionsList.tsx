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

type Props = {
  mint: string;
  ticker?: string;
  trades?: Trade[];
  spotSol: number;
  solUsd: number | null;
  connectedWallet?: string | null;
  omnipairPoolSnapshot?: OmnipairPoolSnapshot | null;
  onCountChange?: (count: number) => void;
};

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
      <span className="text-[12px] text-white/75">{clamped.toFixed(2)}%</span>
    </span>
  );
}

function SectionShell({
  title,
  count,
  summary,
  open,
  onToggle,
  actionLabel,
  children,
}: {
  title: string;
  count: number;
  summary: ReactNode;
  open: boolean;
  onToggle: () => void;
  actionLabel?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="overflow-hidden rounded-xl border border-white/[0.06] bg-white/[0.02]">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center gap-3 px-3.5 py-3 text-left transition-colors hover:bg-white/[0.03]"
      >
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-[13px] font-semibold text-white">{title}</span>
            <span className="rounded-full bg-white/[0.08] px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-white/50">
              {count}
            </span>
            {actionLabel ? (
              <span className="ml-auto text-[11px] font-medium text-emerald-400/80">
                {actionLabel}
              </span>
            ) : null}
          </div>
          <div className="mt-1.5">{summary}</div>
        </div>
        <ChevronDown
          size={16}
          className={cn(
            "shrink-0 text-white/35 transition-transform",
            open && "rotate-180"
          )}
        />
      </button>
      {open ? (
        <div className="border-t border-white/[0.05] px-2 pb-2 pt-1">
          {children}
        </div>
      ) : null}
    </div>
  );
}

export default function TokenPositionsList({
  mint,
  ticker = "TOKEN",
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
  const [loansOpen, setLoansOpen] = useState(true);
  const [historyOpen, setHistoryOpen] = useState(true);
  const [local, setLocal] = useState<OpenLeveragePosition[]>([]);
  const [onChain, setOnChain] = useState<OmnipairUserPositionView | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [loadingChain, setLoadingChain] = useState(false);

  const usd = solUsd ?? 140;

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

  // If on-chain exists but no local loan/trade, synthesize a row for display.
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
    // Heuristic: short or leveraged long with local missing → show as trade
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
    // Synthesize a loan row from on-chain when Borrow was used (no local loan yet).
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

  useEffect(() => {
    onCountChange?.(displayTrades.length + displayLoans.length);
  }, [displayTrades.length, displayLoans.length, onCountChange]);

  const mySwaps = useMemo(() => {
    if (!connectedWallet) return [];
    return trades
      .filter(
        t =>
          t.trader?.toLowerCase() === connectedWallet.toLowerCase() &&
          (t.type === "buy" || t.type === "sell")
      )
      .slice(0, 40);
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
    if (risk && displayTrades.length > 0 && value <= 0) {
      value = Math.max(0, risk.collateralUsd - risk.debtUsd);
    }
    return { value, pnl, exposure };
  }, [displayTrades, spotSol, risk]);

  const loansSummary = useMemo(() => {
    if (risk && displayLoans.length > 0) {
      return {
        value: risk.collateralUsd,
        owes: risk.debtUsd,
      };
    }
    let value = 0;
    let owes = 0;
    for (const p of displayLoans) {
      value += p.marginUi * (p.entrySpotSol || spotSol) * usd;
      owes += (p.borrowSolUi ?? 0) * usd;
    }
    return { value, owes };
  }, [displayLoans, risk, spotSol, usd]);

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
        Connect your wallet to see Trades, Loans, and your swap history.
      </p>
    );
  }

  const renderTradeRow = (p: OpenLeveragePosition) => {
    const { markUsd, pnlUsd } = tradePnlUsd(p, spotSol);
    const toLiq = risk?.toLiquidationPct ?? 100;
    const expanded = expandedId === p.id;
    const busy = busyId === p.id;
    const sizeLabel =
      p.leverage > 0
        ? `${p.leverage.toFixed(1)}x ${p.direction === "long" ? "Long" : "Short"} ${formatNumber(p.marginUi)} ${ticker}`
        : `${p.direction === "long" ? "Long" : "Short"} ${ticker}`;

    return (
      <div
        key={p.id}
        className="mb-1 overflow-hidden rounded-lg border border-white/[0.04] bg-black/20"
      >
        <button
          type="button"
          className="grid w-full grid-cols-[1fr_auto] items-center gap-2 px-3 py-2.5 text-left sm:grid-cols-[minmax(0,1.4fr)_90px_80px_70px_24px]"
          onClick={() => setExpandedId(expanded ? null : p.id)}
        >
          <span className="truncate text-[12px] font-medium text-white/85">
            {sizeLabel}
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
            {markUsd > 0 ? formatUSD(markUsd) : risk ? formatUSD(Math.max(0, risk.collateralUsd - risk.debtUsd)) : "—"}
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
          <div className="space-y-3 border-t border-white/[0.05] px-3 py-3">
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
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                disabled={busy || !omnipairPoolSnapshot}
                className="rounded-full border border-white/10 px-3 py-1 text-[11px] font-medium text-white/75 hover:bg-white/[0.06] disabled:opacity-40"
                onClick={() => void onClose(p)}
              >
                {busy ? "Closing…" : "Close"}
              </button>
              <button
                type="button"
                disabled={busy || !omnipairPoolSnapshot}
                className="rounded-full border border-white/10 px-3 py-1 text-[11px] font-medium text-white/75 hover:bg-white/[0.06] disabled:opacity-40"
                onClick={() => void onRepay(p)}
              >
                Repay
              </button>
              <button
                type="button"
                disabled={busy || !omnipairPoolSnapshot}
                className="rounded-full border border-white/10 px-3 py-1 text-[11px] font-medium text-white/75 hover:bg-white/[0.06] disabled:opacity-40"
                onClick={() => void onWithdraw(p)}
              >
                Withdraw collateral
              </button>
            </div>
            <div className="grid gap-2 text-[11px] text-white/45 sm:grid-cols-2">
              <div>
                <span className="text-white/30">Entry</span>{" "}
                {p.entrySpotSol > 0
                  ? `$${(p.entrySpotSol * p.entrySolUsd).toPrecision(4)}`
                  : "—"}
              </div>
              <div>
                <span className="text-white/30">Mark</span>{" "}
                {spotSol > 0 ? `$${(spotSol * usd).toPrecision(4)}` : "—"}
              </div>
              <div>
                <span className="text-white/30">LTV</span>{" "}
                {risk ? `${(risk.ltv * 100).toFixed(2)}%` : "—"}
              </div>
              <div>
                <span className="text-white/30">To liquidation</span>{" "}
                {risk ? `${risk.toLiquidationPct.toFixed(2)}%` : "—"}
              </div>
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
      <div
        key={p.id}
        className="mb-1 overflow-hidden rounded-lg border border-white/[0.04] bg-black/20"
      >
        <button
          type="button"
          className="grid w-full grid-cols-[1fr_auto] items-center gap-2 px-3 py-2.5 text-left sm:grid-cols-[minmax(0,1.3fr)_90px_70px_70px_70px_24px]"
          onClick={() => setExpandedId(expanded ? null : p.id)}
        >
          <span className="truncate text-[12px] font-medium text-white/85">
            Borrowed {borrowedSol > 0 ? borrowedSol.toFixed(3) : "—"} SOL
          </span>
          <span className="hidden sm:inline-flex">
            <ToLiqRing pct={toLiq} />
          </span>
          <span className="hidden rounded-full bg-white/[0.06] px-2 py-0.5 text-center text-[10px] text-white/45 sm:inline">
            var APR
          </span>
          <span className="text-right text-[12px] tabular-nums text-white/70">
            {formatUSD(owes)}
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
          <div className="space-y-3 border-t border-white/[0.05] px-3 py-3">
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
                className="rounded-full border border-white/10 px-3 py-1 text-[11px] font-medium text-white/75 hover:bg-white/[0.06] disabled:opacity-40"
                onClick={() => void onRepay(p)}
              >
                Repay
              </button>
              <button
                type="button"
                disabled={busy || !omnipairPoolSnapshot}
                className="rounded-full border border-white/10 px-3 py-1 text-[11px] font-medium text-white/75 hover:bg-white/[0.06] disabled:opacity-40"
                onClick={() => void onWithdraw(p)}
              >
                Withdraw collateral
              </button>
              <button
                type="button"
                disabled={busy || !omnipairPoolSnapshot}
                className="rounded-full border border-white/10 px-3 py-1 text-[11px] font-medium text-white/75 hover:bg-white/[0.06] disabled:opacity-40"
                onClick={() => void onClose(p)}
              >
                {busy ? "Closing…" : "Close loan"}
              </button>
            </div>
            <div className="grid gap-2 text-[11px] text-white/45 sm:grid-cols-2">
              <div>
                <span className="text-white/30">Collateral</span>{" "}
                {formatNumber(p.marginUi)} {ticker} ({formatUSD(value)})
              </div>
              <div>
                <span className="text-white/30">Debt</span>{" "}
                {borrowedSol.toFixed(4)} SOL ({formatUSD(owes)})
              </div>
              <div>
                <span className="text-white/30">LTV</span>{" "}
                {risk
                  ? `${(risk.ltv * 100).toFixed(2)}%`
                  : "—"}
                {risk ? (
                  <span className="text-white/30">
                    {" "}
                    · {(risk.liquidationLtv * 100).toFixed(0)}% max
                  </span>
                ) : null}
              </div>
              <div>
                <span className="text-white/30">Market</span> {ticker} / SOL
              </div>
            </div>
          </div>
        ) : null}
      </div>
    );
  };

  return (
    <div className="space-y-3 px-0.5 py-2">
      {loadingChain ? (
        <p className="px-1 text-[11px] text-white/30">Syncing on-chain position…</p>
      ) : null}

      <SectionShell
        title="Trades"
        count={displayTrades.length}
        open={tradesOpen}
        onToggle={() => setTradesOpen(v => !v)}
        summary={
          <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 text-[12px]">
            <span className="text-[18px] font-semibold tabular-nums text-white">
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
            <span className="text-white/40">
              Exposure {formatUSD(tradesSummary.exposure)}
            </span>
          </div>
        }
      >
        {displayTrades.length === 0 ? (
          <p className="px-2 py-6 text-center text-[12px] text-white/35">
            No open leverage positions. Open one from Leverage.
          </p>
        ) : (
          displayTrades.map(renderTradeRow)
        )}
      </SectionShell>

      <SectionShell
        title="Loans"
        count={displayLoans.length}
        open={loansOpen}
        onToggle={() => setLoansOpen(v => !v)}
        summary={
          <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 text-[12px]">
            <span className="text-[18px] font-semibold tabular-nums text-white">
              {formatUSD(loansSummary.value)}
            </span>
            <span className="text-white/45">
              Owes: {formatUSD(loansSummary.owes)}
            </span>
          </div>
        }
      >
        {displayLoans.length === 0 ? (
          <p className="px-2 py-6 text-center text-[12px] text-white/35">
            No open loans. Borrow SOL against {ticker} from Borrow.
          </p>
        ) : (
          displayLoans.map(renderLoanRow)
        )}
      </SectionShell>

      <SectionShell
        title="History"
        count={mySwaps.length}
        open={historyOpen}
        onToggle={() => setHistoryOpen(v => !v)}
        summary={
          <span className="text-[12px] text-white/40">
            Your buys & sells on this token
          </span>
        }
      >
        {mySwaps.length === 0 ? (
          <p className="px-2 py-6 text-center text-[12px] text-white/35">
            No swaps yet from this wallet.
          </p>
        ) : (
          <div className="max-h-[280px] space-y-0.5 overflow-y-auto scrollbar-hide">
            {mySwaps.map(t => (
              <div
                key={t.id || t.txSignature}
                className="flex items-center justify-between gap-2 rounded-lg px-3 py-2 text-[12px] hover:bg-white/[0.03]"
              >
                <span
                  className={cn(
                    "font-semibold uppercase",
                    t.type === "buy" ? "text-emerald-400" : "text-red-400"
                  )}
                >
                  {t.type}
                </span>
                <span className="tabular-nums text-white/70">
                  {t.solAmount > 0 ? `${t.solAmount.toFixed(4)} SOL` : "—"}
                </span>
                <span className="tabular-nums text-white/45">
                  {t.tokenAmount > 0 ? formatNumber(t.tokenAmount) : "—"}
                </span>
                {t.txSignature ? (
                  <a
                    href={`https://solscan.io/tx/${t.txSignature}?cluster=devnet`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="font-mono text-[10px] text-white/30 hover:text-white/60"
                    onClick={e => e.stopPropagation()}
                  >
                    {shortenAddress(t.txSignature, 4)}
                  </a>
                ) : null}
              </div>
            ))}
          </div>
        )}
      </SectionShell>
    </div>
  );
}
