"use client";

import { useState, useRef, useEffect, type ReactNode } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import type { AnchorWallet } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { ArrowDownUp } from "lucide-react";
import { Token } from "@/types";
import { cn, formatUSD, formatSolPerTokenPrice, formatTokenPriceUsd } from "@/lib/utils";
import { LabelWithHint } from "@/components/ui/FieldHint";
import toast from "react-hot-toast";
import type { OmnipairPoolSnapshot } from "@/lib/omnipairPoolState";
import { sendOmnipairSwapTx, omnipairMaxBuySolUi } from "@/lib/omnipairSwap";
import { sendOmnipairAddLiquidityTx } from "@/lib/omnipairLiquidity";
import {
  sendOmnipairBorrowAgainstProjectTx,
  sendOmnipairLeverageStepTx,
} from "@/lib/omnipairLending";
import { useWalletBalances } from "@/hooks/useWalletBalances";
import { persistLaunchpadTrade } from "@/lib/persistLaunchpadTrade";
import { useSolUsd } from "@/hooks/useSolUsd";
import {
  clampLeverage,
  MIN_LEVERAGE,
  poolMaxLeverage,
  poolMaxMarginUi,
  poolSafeCf,
} from "@/lib/poolMaxLeverage";
import {
  listOpenPositions,
  markPositionValueUsd,
  upsertOpenPosition,
} from "@/lib/openPositions";
import { PLATFORM_FEE_PCT_LABEL } from "@/lib/platformFee";

type Mode = "swap" | "leverage" | "borrow";

/** Mode icons scraped from beta.omnipair.fi trade tabs (Leverage / Borrow / Swap). */
function OmnipairTabIcon({ mode }: { mode: Mode }) {
  const src =
    mode === "leverage"
      ? "/icons/omnipair/tab-leverage.svg"
      : mode === "borrow"
        ? "/icons/omnipair/tab-borrow.svg"
        : "/icons/omnipair/tab-swap.svg";
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt=""
      width={14}
      height={14}
      className="h-3.5 w-3.5 shrink-0 opacity-90 [filter:invert(1)]"
    />
  );
}

function isLikelyBenignWalletOrRpcNoise(e: unknown): boolean {
  const m = (e instanceof Error ? e.message : String(e)).toLowerCase();
  return (
    (m.includes("ws") && m.includes("undefined")) ||
    (m.includes("websocket") && m.includes("undefined"))
  );
}

/** Omnipair-style Long/Short or Buy/Sell pair */
function TalesSegmentToggle<T extends string>({
  options,
  value,
  onChange,
  disabled,
  tone = "neutral",
}: {
  options: [{ id: T; label: string }, { id: T; label: string }];
  value: T;
  onChange: (v: T) => void;
  disabled?: boolean;
  tone?: "neutral" | "signed";
}) {
  return (
    <div className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-white/[0.08] bg-white/[0.06]">
      {options.map((opt, i) => {
        const active = value === opt.id;
        const signed =
          tone === "signed"
            ? i === 0
              ? active
                ? "bg-emerald-500/15 text-emerald-300"
                : "bg-[#0c0c0c] text-white/40 hover:text-white/60"
              : active
                ? "bg-red-500/15 text-red-300"
                : "bg-[#0c0c0c] text-white/40 hover:text-white/60"
            : active
              ? "bg-white/[0.08] text-white"
              : "bg-[#0c0c0c] text-white/40 hover:text-white/60";
        return (
          <button
            key={opt.id}
            type="button"
            disabled={disabled}
            onClick={() => onChange(opt.id)}
            className={cn(
              "px-2 py-2.5 text-sm font-semibold transition-colors disabled:opacity-50",
              signed
            )}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

function TalesTradeField({
  label,
  suffix,
  headerRight,
  children,
}: {
  label: string;
  suffix?: string;
  headerRight?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="border-b border-white/[0.06] px-0.5 py-3">
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <span className="text-[11px] font-medium text-white/40">{label}</span>
        <div className="flex items-center gap-2">
          {headerRight}
          {suffix ? (
            <span className="max-w-[90px] truncate text-[11px] font-medium text-white/55">
              {suffix}
            </span>
          ) : null}
        </div>
      </div>
      {children}
    </div>
  );
}

function TalesTradeDetailsRow({
  label,
  value,
  valueClassName,
}: {
  label: ReactNode;
  value: ReactNode;
  valueClassName?: string;
}) {
  return (
    <div className="flex items-center justify-between gap-3 py-1">
      <span className="text-[11px] text-white/40">{label}</span>
      <span className={cn("text-[11px] tabular-nums text-white/75", valueClassName)}>
        {value}
      </span>
    </div>
  );
}

interface Props {
  token: Token;
  /** Omnipair reserve-implied spot (SOL per token); when set, swap estimates use this instead of bonding price. */
  spotPriceSol?: number | null;
  /** When set with a positive spot, swap executes real Omnipair `swap` (WSOL ↔ token). */
  omnipairPoolSnapshot?: OmnipairPoolSnapshot | null;
  /** Open leverage tab (e.g. from home Long/Short links). */
  initialMode?: Mode;
  initialLeverageDirection?: "long" | "short";
}

/* ── Slippage popover ──────────────────────────────────────────────── */
function SlippageButton({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(value);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const commit = () => {
    const v = parseFloat(draft);
    if (!isNaN(v) && v > 0) onChange(String(v));
    setOpen(false);
  };

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => { setDraft(value); setOpen(o => !o); }}
        className="rounded-full bg-white/[0.06] px-2.5 py-1 text-[11px] font-medium text-white/50 transition-colors hover:bg-white/10 hover:text-white/75"
      >
        Max slippage · {value}%
      </button>

      {open && (
        <div className="absolute right-0 top-8 z-20 w-60 rounded-xl border border-white/10 bg-zinc-900 p-4 shadow-xl">
          <p className="mb-1 text-sm font-semibold text-white">Max slippage (%)</p>
          <p className="mb-3 text-xs leading-relaxed text-white/45">
            Max slippage you are willing to accept when placing trades.
          </p>
          <input
            type="number"
            value={draft}
            onChange={e => setDraft(e.target.value)}
            onKeyDown={e => e.key === "Enter" && commit()}
            autoFocus
            className="mb-3 w-full rounded-lg bg-white/[0.06] px-3 py-2 text-sm font-medium text-white focus:outline-none"
          />
          <button
            type="button"
            onClick={commit}
            className="w-full rounded-full bg-[#f4f4f5] py-2 text-sm font-semibold text-[#0a0a0a] transition-[filter] hover:brightness-105"
          >
            Done
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * Shared pool-capped range control (same chrome as Borrow LTV).
 * Used for leverage (×) and borrow LTV (%).
 */
function TalesPoolRangeSlider({
  label,
  labelHint,
  value,
  min,
  max,
  step = 0.1,
  formatValue,
  footerLeft,
  footerCenter,
  footerRight,
  onChange,
  ariaLabel,
}: {
  label: ReactNode;
  labelHint?: ReactNode;
  value: number;
  min: number;
  max: number;
  step?: number;
  formatValue: (v: number) => string;
  footerLeft: ReactNode;
  footerCenter: ReactNode;
  footerRight: ReactNode;
  onChange: (v: number) => void;
  ariaLabel: string;
}) {
  const hi = Math.max(min + step, max);
  const clamped = Math.min(Math.max(value, min), hi);
  const fill = Math.min(100, ((clamped - min) / (hi - min)) * 100);
  const nearMax = clamped >= hi * 0.85;
  const maxAttr = Number(hi.toFixed(Math.max(1, String(step).split(".")[1]?.length ?? 1)));

  return (
    <div className="space-y-2.5 px-0.5 pt-2">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[11px] font-medium text-white/45">
          {labelHint ? (
            <LabelWithHint hint={labelHint}>{label}</LabelWithHint>
          ) : (
            label
          )}
        </span>
        <span className="text-sm font-semibold tabular-nums text-white">
          {formatValue(clamped)}
        </span>
      </div>

      <div className="relative h-8 touch-none select-none">
        <div className="pointer-events-none absolute inset-x-0 top-1/2 h-1.5 -translate-y-1/2 overflow-hidden rounded-full bg-white/10">
          <div
            className={cn(
              "h-full rounded-full will-change-[width]",
              nearMax ? "bg-amber-400/90" : "bg-emerald-400/90"
            )}
            style={{ width: `${fill}%` }}
          />
        </div>
        <input
          type="range"
          min={min}
          max={maxAttr}
          step={step}
          value={clamped}
          onInput={e => onChange(parseFloat((e.target as HTMLInputElement).value))}
          onChange={e => onChange(parseFloat(e.target.value))}
          className={cn(
            "absolute inset-0 z-10 w-full cursor-pointer appearance-none bg-transparent",
            "[&::-webkit-slider-runnable-track]:h-8 [&::-webkit-slider-runnable-track]:bg-transparent",
            "[&::-webkit-slider-thumb]:relative [&::-webkit-slider-thumb]:mt-[10px]",
            "[&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:w-4",
            "[&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full",
            "[&::-webkit-slider-thumb]:border-0 [&::-webkit-slider-thumb]:bg-white",
            "[&::-webkit-slider-thumb]:shadow-[0_0_0_3px_rgba(0,0,0,0.35)]",
            "[&::-moz-range-track]:h-1.5 [&::-moz-range-track]:rounded-full [&::-moz-range-track]:bg-transparent",
            "[&::-moz-range-thumb]:h-4 [&::-moz-range-thumb]:w-4 [&::-moz-range-thumb]:rounded-full",
            "[&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:bg-white"
          )}
          aria-label={ariaLabel}
        />
      </div>

      <div className="flex items-center justify-between gap-3 text-[10px] tabular-nums">
        <span className="text-white/35">{footerLeft}</span>
        <span className="min-w-0 flex-1 text-center text-white/50">{footerCenter}</span>
        <span className="text-white/70">{footerRight}</span>
      </div>
    </div>
  );
}

function LeverageRangeControl({
  value,
  onChange,
  maxLev,
  depthSol,
}: {
  value: number;
  onChange: (v: number) => void;
  maxLev: number;
  depthSol: number;
}) {
  const hi = Math.max(MIN_LEVERAGE + 0.05, maxLev);
  return (
    <TalesPoolRangeSlider
      label="Leverage"
      labelHint="How much borrowed size vs your margin. Higher leverage amplifies gains and losses and moves you closer to liquidation."
      value={value}
      min={MIN_LEVERAGE}
      max={hi}
      step={0.05}
      formatValue={v => `${v.toFixed(1)}x`}
      ariaLabel="Leverage"
      onChange={onChange}
      footerLeft={`${MIN_LEVERAGE.toFixed(1)}x`}
      footerCenter={
        <>
          Pool max{" "}
          <span className="font-semibold text-white/80">{hi.toFixed(1)}x</span>
          {depthSol > 0 ? (
            <span className="text-white/35">
              {" "}
              · {depthSol < 1 ? "thin" : depthSol < 5 ? "moderate" : "deep"}{" "}
              {depthSol.toFixed(2)} SOL
            </span>
          ) : null}
        </>
      }
      footerRight={
        <button
          type="button"
          className="font-semibold text-white/75 hover:text-white"
          onClick={() => onChange(hi)}
        >
          Max {hi.toFixed(1)}x
        </button>
      }
    />
  );
}

/* ── Root component ────────────────────────────────────────────────── */

export default function TradingInterface({
  token,
  spotPriceSol,
  omnipairPoolSnapshot,
  initialMode = "swap",
  initialLeverageDirection,
}: Props) {
  const { connected } = useWallet();
  const [mode, setMode] = useState<Mode>(initialMode);
  const usingPoolSpot =
    spotPriceSol != null && Number.isFinite(spotPriceSol) && spotPriceSol > 0;
  const omnipairSwapReady =
    usingPoolSpot &&
    omnipairPoolSnapshot != null &&
    omnipairPoolSnapshot.spotPriceSol > 0;

  const tabs: { id: Mode; label: string }[] = [
    { id: "swap", label: "Swap" },
    { id: "borrow", label: "Borrow" },
    { id: "leverage", label: "Leverage" },
  ];

  return (
    <div className="overflow-hidden rounded-2xl border border-white/[0.08] bg-[#0c0c0c]">
      <div className="flex gap-1 border-b border-white/[0.06] p-2">
        {tabs.map(t => (
          <button
            key={t.id}
            type="button"
            onClick={() => setMode(t.id)}
            className={cn(
              "inline-flex flex-1 items-center justify-center gap-1.5 rounded-xl px-3 py-2.5 text-[12px] font-semibold tracking-wide transition-colors",
              mode === t.id
                ? t.id === "swap"
                  ? "bg-[#ff5a1f]/18 text-[#ff8a55] ring-1 ring-[#ff5a1f]/35"
                  : t.id === "leverage"
                    ? "bg-[#3b82f6]/18 text-[#93c5fd] ring-1 ring-[#3b82f6]/35"
                    : "bg-white/[0.08] text-white ring-1 ring-white/15"
                : "text-white/40 hover:bg-white/[0.04] hover:text-white/70"
            )}
          >
            <OmnipairTabIcon mode={t.id} />
            {t.label}
          </button>
        ))}
      </div>

      <div className="space-y-3 p-4">
        {mode === "swap" ? (
          <SwapPanel
            token={token}
            connected={connected}
            spotPriceSol={usingPoolSpot ? spotPriceSol! : null}
            omnipairPoolSnapshot={omnipairSwapReady ? omnipairPoolSnapshot! : null}
          />
        ) : null}
        {mode === "leverage" ? (
          <LeveragePanel
            token={token}
            connected={connected}
            initialDirection={initialLeverageDirection}
            omnipairPoolSnapshot={omnipairSwapReady ? omnipairPoolSnapshot! : null}
          />
        ) : null}
        {mode === "borrow" ? (
          <BorrowPanel
            token={token}
            connected={connected}
            omnipairPoolSnapshot={omnipairSwapReady ? omnipairPoolSnapshot! : null}
          />
        ) : null}
      </div>
    </div>
  );
}

export function OmnipairLiquidityPanel({
  token,
  connected,
  omnipairPoolSnapshot,
}: {
  token: Token;
  connected: boolean;
  omnipairPoolSnapshot: OmnipairPoolSnapshot | null;
}) {
  const { connection } = useConnection();
  const walletAdapter = useWallet();
  const [solAmount, setSolAmount] = useState("");
  const [loading, setLoading] = useState(false);

  const handleAdd = async () => {
    if (!connected || !omnipairPoolSnapshot) return;
    const num = parseFloat(solAmount);
    if (!(num > 0)) {
      toast.error("Enter SOL amount");
      return;
    }
    if (!walletAdapter.publicKey || !walletAdapter.signTransaction) {
      toast.error("Connect a signing wallet");
      return;
    }
    setLoading(true);
    try {
      const wallet = {
        publicKey: walletAdapter.publicKey,
        signTransaction: walletAdapter.signTransaction.bind(walletAdapter),
        signAllTransactions:
          walletAdapter.signAllTransactions?.bind(walletAdapter) ??
          (async <T,>(txs: T[]) => txs),
      };
      const sig = await sendOmnipairAddLiquidityTx({
        connection,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        wallet: wallet as any,
        snapshot: omnipairPoolSnapshot,
        solUi: num,
        slippagePercent: 5,
      });
      toast.success(`LP added · ${sig.slice(0, 8)}…`);
      setSolAmount("");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Add LP failed");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-3">
      <p className="text-[11px] leading-relaxed text-white/50">
        Provide both sides of the pool (we quote the token leg from live reserves). You earn swap fees as an LP on Omnipair.
      </p>
      <TalesTradeField
        label="Deposit (SOL leg)"
        suffix={`+ ${token.ticker}`}
      >
        <input
          type="number"
          value={solAmount}
          onChange={e => setSolAmount(e.target.value)}
          placeholder="0.0"
          className="w-full bg-transparent text-2xl font-semibold tracking-tight text-white placeholder:text-white/20 focus:outline-none"
        />
      </TalesTradeField>
      {connected ? (
        <button
          type="button"
          disabled={loading || !omnipairPoolSnapshot || !solAmount}
          onClick={handleAdd}
          className="w-full rounded-full bg-[#f4f4f5] py-3 text-sm font-semibold text-[#0a0a0a] transition-[filter] hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-45"
        >
          {loading ? "Adding liquidity…" : "Add liquidity"}
        </button>
      ) : (
        <WalletMultiButton />
      )}
    </div>
  );
}

function formatSwapAmountInput(n: number, maxDecimals: number): string {
  if (!Number.isFinite(n) || n <= 0) return "";
  const t = 10 ** maxDecimals;
  const floored = Math.floor(n * t) / t;
  return floored.toFixed(maxDecimals).replace(/\.?0+$/, "");
}

const SOL_TOKEN_ICON = "/icons/sol.svg";

function SwapTokenChip({
  symbol,
  iconUrl,
}: {
  symbol: string;
  iconUrl?: string | null;
}) {
  const isSol = symbol.toUpperCase() === "SOL";
  const resolvedIcon = iconUrl?.trim() || (isSol ? SOL_TOKEN_ICON : null);
  return (
    <span className="inline-flex max-w-[11rem] shrink-0 items-center gap-1.5 rounded-full border border-white/10 bg-[#0a0a0a] py-1.5 pl-1.5 pr-2.5 text-[12px] font-semibold text-white sm:max-w-none sm:text-[13px]">
      <span className="relative size-6 shrink-0 overflow-hidden rounded-full bg-white/10">
        {resolvedIcon ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={resolvedIcon}
            alt=""
            width={24}
            height={24}
            className="size-6 object-cover"
          />
        ) : (
          <span className="flex size-6 items-center justify-center text-[9px] font-bold text-white/50">
            {symbol.slice(0, 2).toUpperCase()}
          </span>
        )}
      </span>
      <span className="min-w-0 truncate" title={symbol}>
        {symbol}
      </span>
    </span>
  );
}

/* ─── Swap ───────────────────────────────────────────────────────── */

function SwapPanel({
  token,
  connected,
  spotPriceSol,
  omnipairPoolSnapshot,
}: {
  token: Token;
  connected: boolean;
  spotPriceSol: number | null;
  omnipairPoolSnapshot: OmnipairPoolSnapshot | null;
}) {
  const { connection } = useConnection();
  const walletAdapter = useWallet();
  const swapPendingRef = useRef(false);
  const {
    solBalanceLamports,
    tokenBalanceRaw,
    tokenDecimals,
    loading: walletBalLoading,
    refreshBalances,
  } = useWalletBalances(token.mint);
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [amount, setAmount] = useState("");
  const [slippage, setSlippage] = useState("8");
  const [loading, setLoading] = useState(false);

  const priceSol =
    spotPriceSol != null && spotPriceSol > 0 ? spotPriceSol : token.currentPrice;

  const num = parseFloat(amount) || 0;
  const estimated =
    side === "buy"
      ? num > 0 && priceSol > 0 ? Math.floor(num / priceSol) : 0
      : num * priceSol;

  const displayTicker =
    token.ticker.length > 8 ? token.ticker.slice(0, 7) + "…" : token.ticker;
  const projectIcon = token.imageUrl?.trim() || null;

  const applyOmnipairQuickPercent = (pct: number) => {
    if (!omnipairPoolSnapshot) return;
    if (side === "buy") {
      const maxSol = omnipairMaxBuySolUi(solBalanceLamports);
      const sol = (maxSol * pct) / 100;
      setAmount(formatSwapAmountInput(sol, 9));
    } else {
      const raw = BigInt(tokenBalanceRaw || "0");
      const slice = (raw * BigInt(pct)) / BigInt(100);
      const ui = Number(slice) / 10 ** tokenDecimals;
      setAmount(
        formatSwapAmountInput(ui, Math.min(8, tokenDecimals))
      );
    }
  };

  const handleTrade = async () => {
    if (!connected || !amount || swapPendingRef.current) return;
    swapPendingRef.current = true;
    setLoading(true);
    try {
      if (
        omnipairPoolSnapshot &&
        walletAdapter.publicKey &&
        walletAdapter.signTransaction
      ) {
        const slip = parseFloat(slippage);
        const anchorWallet = {
          publicKey: walletAdapter.publicKey,
          signTransaction: walletAdapter.signTransaction.bind(walletAdapter),
          signAllTransactions:
            walletAdapter.signAllTransactions?.bind(walletAdapter) ??
            (async <T,>(txs: T[]) => {
              const out: T[] = [];
              for (const t of txs) {
                out.push(await walletAdapter.signTransaction!(t as never));
              }
              return out;
            }),
        } as AnchorWallet;
        if (side === "sell") {
          console.info("[omnipair:swap] SELL: UI swap request", {
            amountUi: num,
            mint: token.mint,
          });
        }
        const { signature, fill } = await sendOmnipairSwapTx({
          connection,
          wallet: anchorWallet,
          snapshot: omnipairPoolSnapshot,
          side,
          amountUi: num,
          slippagePercent: Number.isFinite(slip) ? slip : 5,
        });
        toast.success(
          `${side === "buy" ? "Bought" : "Sold"} ${token.ticker} (Omnipair)`
        );
        void persistLaunchpadTrade({
          mint: token.mint,
          signature,
          side,
          sol_amount_raw: fill.sol_amount_raw,
          token_amount_raw: fill.token_amount_raw,
          timestamp: fill.timestamp,
          wallet: walletAdapter.publicKey.toBase58(),
          price_sol: fill.price_sol,
          source: "omnipair",
        });
        if (typeof window !== "undefined") {
          window.dispatchEvent(
            new CustomEvent("higher:trade-complete", {
              detail: {
                mint: token.mint,
                timestamp: fill.timestamp,
                price_sol: fill.price_sol,
                sol_amount_raw: fill.sol_amount_raw,
                token_amount_raw: fill.token_amount_raw,
                source: "omnipair" as const,
              },
            })
          );
        }
        if (side === "sell") {
          console.info("[omnipair:swap] SELL: swap completed — persist + events dispatched", {
            signature,
          });
          void refreshBalances().then(() => {
            console.info(
              "[omnipair:swap] SELL: post-success balances refresh completed"
            );
          });
          console.info(
            "[omnipair:swap] SELL: post-success balances refresh scheduled"
          );
        }
        console.info("[omnipair:swap] done", { signature, side });
      } else {
        await new Promise(r => setTimeout(r, 1200));
        toast.success(`${side === "buy" ? "Bought" : "Sold"} ${token.ticker}`);
      }
      setAmount("");
    } catch (e) {
      console.error("[omnipair:swap] failed", e);
      if (isLikelyBenignWalletOrRpcNoise(e)) {
        console.warn("[omnipair:swap] benign-looking RPC/wallet noise — check balances / explorer", e);
        toast(
          "Swap may have completed; if balances changed, refresh the page. (RPC/wallet message was ignored.)",
          { icon: "ℹ️", duration: 5000 }
        );
      } else {
        toast.error(e instanceof Error ? e.message : "Swap failed");
      }
    } finally {
      swapPendingRef.current = false;
      setLoading(false);
    }
  };

  const spendableSol =
    omnipairPoolSnapshot != null
      ? omnipairMaxBuySolUi(solBalanceLamports)
      : Number(solBalanceLamports) / 1e9;
  const tokenBalUi = Number(tokenBalanceRaw || "0") / 10 ** tokenDecimals;
  const sellToken = side === "buy" ? "SOL" : displayTicker;
  const receiveToken = side === "buy" ? displayTicker : "SOL";
  const sellBalLabel = walletBalLoading
    ? "…"
    : side === "buy"
      ? `${spendableSol.toFixed(4)} SOL`
      : `${tokenBalUi.toLocaleString(undefined, { maximumFractionDigits: 4 })} ${displayTicker}`;
  const receiveEstimate =
    num > 0
      ? side === "buy"
        ? `~${estimated.toLocaleString()}`
        : `~${estimated.toFixed(4)}`
      : "0";
  const rateLabel =
    priceSol > 0
      ? side === "buy"
        ? `1 ${displayTicker} ≈ ${formatSolPerTokenPrice(priceSol)}`
        : `1 SOL ≈ ${(1 / priceSol).toLocaleString(undefined, { maximumFractionDigits: 2 })} ${displayTicker}`
      : "—";

  const flipSide = () => {
    setSide(s => (s === "buy" ? "sell" : "buy"));
    setAmount("");
  };

  const sellIcon = side === "buy" ? SOL_TOKEN_ICON : projectIcon;
  const receiveIcon = side === "buy" ? projectIcon : SOL_TOKEN_ICON;

  return (
    <div className="space-y-3">
      <div className="flex flex-col">
        <div className="rounded-2xl border border-white/[0.08] bg-white/[0.03] px-3.5 py-3">
          <div className="mb-2 flex items-center justify-between gap-2">
            <span className="text-[12px] font-medium text-white/45">You sell</span>
            <div className="flex items-center gap-2">
              <span className="text-[11px] tabular-nums text-white/35">
                {sellBalLabel}
              </span>
              <button
                type="button"
                disabled={loading || (omnipairPoolSnapshot != null && walletBalLoading)}
                onClick={() => {
                  if (omnipairPoolSnapshot) applyOmnipairQuickPercent(100);
                  else setAmount("100");
                }}
                className="rounded-md bg-white/[0.06] px-1.5 py-0.5 text-[10px] font-semibold text-white/55 hover:text-white disabled:opacity-40"
              >
                Max
              </button>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <input
              type="number"
              value={amount}
              onChange={e => setAmount(e.target.value)}
              placeholder="0"
              aria-label="You sell"
              className="min-w-0 flex-1 bg-transparent text-[26px] font-semibold tracking-tight text-white placeholder:text-white/20 focus:outline-none"
            />
            <SwapTokenChip symbol={sellToken} iconUrl={sellIcon} />
          </div>
          <div className="mt-2.5 flex gap-1">
            {([25, 50, 100] as const).map(pct => (
              <button
                key={pct}
                type="button"
                disabled={loading || (omnipairPoolSnapshot != null && walletBalLoading)}
                onClick={() => {
                  if (omnipairPoolSnapshot) applyOmnipairQuickPercent(pct);
                  else setAmount(String(pct));
                }}
                className="rounded-md px-2 py-1 text-[10px] font-semibold text-white/40 transition-colors hover:bg-white/[0.06] hover:text-white/75 disabled:pointer-events-none disabled:opacity-40"
              >
                {pct}%
              </button>
            ))}
          </div>
        </div>

        {/* Flip sits in the gap — not stacked over field content */}
        <div className="relative z-10 -my-3 flex justify-center">
          <button
            type="button"
            aria-label={`Flip tokens: sell ${receiveToken}, receive ${sellToken}`}
            disabled={loading}
            onClick={flipSide}
            className="flex size-9 items-center justify-center rounded-full border border-white/12 bg-[#121212] text-white/65 ring-4 ring-[#0c0c0c] transition-colors hover:border-white/25 hover:text-white disabled:opacity-40"
          >
            <ArrowDownUp size={14} strokeWidth={2.25} />
          </button>
        </div>

        <div className="rounded-2xl border border-white/[0.08] bg-white/[0.03] px-3.5 py-3">
          <div className="mb-2 flex items-center justify-between gap-2">
            <span className="text-[12px] font-medium text-white/45">You receive</span>
            <span className="text-[11px] text-white/30">
              {omnipairPoolSnapshot ? "Omnipair spot" : "Estimate"}
            </span>
          </div>
          <div className="flex items-center gap-3">
            <span
              aria-label="You receive"
              className="min-w-0 flex-1 truncate text-[26px] font-semibold tracking-tight text-white/90"
            >
              {receiveEstimate}
            </span>
            <SwapTokenChip symbol={receiveToken} iconUrl={receiveIcon} />
          </div>
        </div>
      </div>

      <div className="space-y-0 px-0.5 py-0.5">
        <TalesTradeDetailsRow label="Rate" value={rateLabel} />
        <TalesTradeDetailsRow label="Pool fee" value="0.30%" />
        <TalesTradeDetailsRow
          label="Platform fee"
          value={PLATFORM_FEE_PCT_LABEL}
        />
        <div className="flex items-center justify-between gap-3 py-1">
          <span className="text-[11px] text-white/40">Max slippage</span>
          <SlippageButton value={slippage} onChange={setSlippage} />
        </div>
      </div>

      {connected ? (
        <button
          type="button"
          onClick={handleTrade}
          disabled={
            loading ||
            !amount ||
            (omnipairPoolSnapshot != null && walletBalLoading)
          }
          aria-busy={loading}
          className="w-full rounded-xl bg-[#ff5a1f] py-3.5 text-sm font-semibold text-white transition-[filter] hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-45"
        >
          {loading && omnipairPoolSnapshot
            ? "Swapping…"
            : loading
              ? "Processing…"
              : `Swap ${sellToken} → ${receiveToken}`}
        </button>
      ) : (
        <WalletMultiButton />
      )}
    </div>
  );
}

/* ─── Leverage ───────────────────────────────────────────────────── */

function LeveragePanel({
  token,
  connected,
  initialDirection,
  omnipairPoolSnapshot,
}: {
  token: Token;
  connected: boolean;
  initialDirection?: "long" | "short";
  omnipairPoolSnapshot: OmnipairPoolSnapshot | null;
}) {
  const { connection } = useConnection();
  const walletAdapter = useWallet();
  const { solUsd } = useSolUsd();
  const [direction, setDirection] = useState<"long" | "short">(
    initialDirection ?? "long"
  );
  const [size, setSize] = useState("");
  /** When true, margin field tracks Max as leverage changes. */
  const maxPinnedRef = useRef(false);
  const [loading, setLoading] = useState(false);
  /** Last opened long/short — leverage stays fixed; mark moves position value only. */
  const [openPos, setOpenPos] = useState<{
    direction: "long" | "short";
    leverage: number;
    marginUi: number;
    entrySpotSol: number;
    entrySolUsd: number;
  } | null>(null);
  const {
    solBalanceLamports,
    tokenBalanceRaw,
    tokenDecimals,
  } = useWalletBalances(connected ? token.mint : undefined);

  const reserveSol = omnipairPoolSnapshot
    ? Number(omnipairPoolSnapshot.reserveSolRaw) / 1e9
    : 0;
  const maxLev = poolMaxLeverage(reserveSol);
  const [leverage, setLeverage] = useState(() =>
    clampLeverage(Math.min(1.5, maxLev), maxLev)
  );

  const sizeNum = parseFloat(size) || 0;
  const spot =
    omnipairPoolSnapshot?.spotPriceSol && omnipairPoolSnapshot.spotPriceSol > 0
      ? omnipairPoolSnapshot.spotPriceSol
      : token.currentPrice;
  const usd = solUsd ?? 140;
  const currentPriceUSD = spot * usd;
  const lockedLev = clampLeverage(leverage, maxLev);
  const previewPosValueUsd =
    direction === "long"
      ? sizeNum * lockedLev * currentPriceUSD
      : sizeNum * lockedLev * usd;
  const liqPrice =
    direction === "long"
      ? currentPriceUSD * (1 - 1 / Math.max(lockedLev, 1.05) + 0.05)
      : currentPriceUSD * (1 + 1 / Math.max(lockedLev, 1.05) - 0.05);

  const openMark = openPos
    ? markPositionValueUsd(openPos, spot)
    : { entryUsd: 0, markUsd: 0 };

  // Raw balances only — never parse locale strings ("194,659" → 194).
  const walletSol = solBalanceLamports / 1e9;
  const walletTokens =
    Number(tokenBalanceRaw || "0") / 10 ** Math.max(0, tokenDecimals || 6);
  const reserveProjectUi = omnipairPoolSnapshot
    ? Number(omnipairPoolSnapshot.reserveProjectRaw) /
      10 ** Math.max(0, omnipairPoolSnapshot.projectTokenDecimals || 6)
    : 0;

  // Omnipair docs: Max always respects impact CF + borrow liquidity + reserves —
  // including at 1x (especially shorts: you can only borrow what's in the pool).
  const marginCap = poolMaxMarginUi({
    direction,
    leverage: lockedLev,
    spotSol: spot,
    reserveSol,
    reserveProjectUi,
    walletTokens,
    walletSol,
  });
  const maxMargin = marginCap.maxMargin;
  const isOneX = marginCap.borrowFraction < 1e-8;

  const displayTicker =
    token.ticker.length > 6 ? token.ticker.slice(0, 6) + "…" : token.ticker;

  // Keep selection inside pool max when depth / CF changes.
  useEffect(() => {
    setLeverage(prev => clampLeverage(prev, maxLev));
  }, [maxLev]);

  // When Max is pinned (or size exceeds new Max), keep the field on the levered Max.
  useEffect(() => {
    if (!Number.isFinite(maxMargin) || !(maxMargin > 0)) return;
    const n = parseFloat(size);
    const next =
      maxMargin >= 1000
        ? String(Math.floor(maxMargin))
        : String(Number(maxMargin.toPrecision(6)));
    if (maxPinnedRef.current || (n > 0 && n > maxMargin + 1e-12)) {
      if (size !== next) setSize(next);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- sync when caps / lev move
  }, [maxMargin, direction, lockedLev]);

  useEffect(() => {
    if (!walletAdapter.publicKey) return;
    const mine = listOpenPositions(token.mint).find(
      p => p.wallet === walletAdapter.publicKey!.toBase58()
    );
    if (mine) {
      setOpenPos({
        direction: mine.direction,
        leverage: mine.leverage,
        marginUi: mine.marginUi,
        entrySpotSol: mine.entrySpotSol,
        entrySolUsd: mine.entrySolUsd,
      });
    }
  }, [token.mint, walletAdapter.publicKey]);

  const handleOpen = async () => {
    if (!connected || !size || !omnipairPoolSnapshot) {
      toast.error("Connect wallet and wait for the Omnipair pool");
      return;
    }
    let margin = parseFloat(size);
    if (!(margin > 0)) {
      toast.error("Enter margin size");
      return;
    }
    if (Number.isFinite(maxMargin) && margin > maxMargin) {
      toast.error(
        `Max margin for this pool is ${maxMargin.toPrecision(4)} ${
          direction === "short" ? "SOL" : displayTicker
        }`
      );
      return;
    }
    setLoading(true);
    try {
      const wallet = {
        publicKey: walletAdapter.publicKey!,
        signTransaction: walletAdapter.signTransaction!.bind(walletAdapter),
        signAllTransactions: walletAdapter.signAllTransactions!.bind(walletAdapter),
      } as AnchorWallet;
      const levUsed = clampLeverage(leverage, maxLev);
      const { sigs } = await sendOmnipairLeverageStepTx({
        connection,
        wallet,
        snapshot: omnipairPoolSnapshot,
        direction,
        marginUi: margin,
        leverage: levUsed,
        slippagePercent: 8,
      });
      setOpenPos({
        direction,
        leverage: levUsed,
        marginUi: margin,
        entrySpotSol: spot,
        entrySolUsd: usd,
      });
      const primarySig = sigs[sigs.length - 1] || sigs[0];
      if (walletAdapter.publicKey) {
        upsertOpenPosition({
          mint: token.mint,
          wallet: walletAdapter.publicKey.toBase58(),
          kind: "trade",
          direction,
          leverage: levUsed,
          marginUi: margin,
          entrySpotSol: spot,
          entrySolUsd: usd,
          signature: primarySig || "",
        });
      }
      toast.success(
        `${direction === "long" ? "Long" : "Short"} ${levUsed.toFixed(1)}x opened — leverage locked`
      );
      if (primarySig && walletAdapter.publicKey) {
        const solRaw =
          direction === "short"
            ? BigInt(Math.floor(margin * 1e9)).toString()
            : BigInt(Math.floor(margin * spot * 1e9)).toString();
        const tokRaw =
          direction === "long"
            ? BigInt(Math.floor(margin * 1e6)).toString()
            : "0";
        void persistLaunchpadTrade({
          mint: token.mint,
          signature: primarySig,
          side: direction,
          sol_amount_raw: solRaw,
          token_amount_raw: tokRaw,
          timestamp: new Date().toISOString(),
          wallet: walletAdapter.publicKey.toBase58(),
          price_sol: spot,
          source: "omnipair",
        });
      }
      window.dispatchEvent(
        new CustomEvent("higher:trade-complete", {
          detail: {
            mint: token.mint,
            source: "omnipair-leverage",
            side: direction,
            signature: primarySig,
          },
        })
      );
    } catch (e) {
      if (!isLikelyBenignWalletOrRpcNoise(e)) {
        toast.error(e instanceof Error ? e.message : String(e));
      }
    } finally {
      setLoading(false);
    }
  };

  const projectIcon = token.imageUrl?.trim() || null;
  const marginChip =
    direction === "long" ? (
      <SwapTokenChip symbol={displayTicker} iconUrl={projectIcon} />
    ) : (
      <SwapTokenChip symbol="SOL" iconUrl={SOL_TOKEN_ICON} />
    );

  return (
    <div className="space-y-2.5">
      <TalesSegmentToggle
        tone="signed"
        options={[
          { id: "long" as const, label: "Long" },
          { id: "short" as const, label: "Short" },
        ]}
        value={direction}
        onChange={d => {
          maxPinnedRef.current = false;
          setDirection(d);
        }}
      />

      {openPos ? (
        <div className="rounded-xl border border-white/[0.08] bg-white/[0.03] px-3.5 py-3">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <SwapTokenChip
                symbol={displayTicker}
                iconUrl={projectIcon}
              />
              <span
                className={cn(
                  "text-[12px] font-semibold",
                  openPos.direction === "long"
                    ? "text-emerald-400"
                    : "text-red-400"
                )}
              >
                {openPos.leverage.toFixed(1)}x{" "}
                {openPos.direction === "long" ? "Long" : "Short"}
              </span>
            </div>
            <button
              type="button"
              className="text-[11px] text-white/35 hover:text-white/65"
              onClick={() => setOpenPos(null)}
            >
              Hide
            </button>
          </div>
          <div className="mt-3 grid grid-cols-2 gap-2">
            <div>
              <p className="text-[10px] text-white/35">Value</p>
              <p
                className={cn(
                  "text-[14px] font-semibold tabular-nums",
                  openMark.markUsd < openMark.entryUsd
                    ? "text-red-400"
                    : "text-white"
                )}
              >
                {formatUSD(openMark.markUsd)}
              </p>
            </div>
            <div className="text-right">
              <p className="text-[10px] text-white/35">PnL</p>
              <p
                className={cn(
                  "text-[14px] font-semibold tabular-nums",
                  openMark.markUsd - openMark.entryUsd >= 0
                    ? "text-emerald-400"
                    : "text-red-400"
                )}
              >
                {openMark.markUsd - openMark.entryUsd >= 0 ? "+" : ""}
                {formatUSD(openMark.markUsd - openMark.entryUsd)}
              </p>
            </div>
          </div>
        </div>
      ) : null}

      <div className="rounded-xl border border-white/[0.08] bg-white/[0.03] px-3.5 py-3">
        <div className="mb-2 flex items-center justify-between gap-2">
          <span className="text-[12px] font-medium text-white/45">
            {direction === "long" ? "Margin" : "Margin"}
          </span>
          {Number.isFinite(maxMargin) && maxMargin > 0 ? (
            <button
              type="button"
              className="text-[11px] font-semibold tabular-nums text-white/50 hover:text-white"
              onClick={() => {
                maxPinnedRef.current = true;
                setSize(
                  maxMargin >= 1000
                    ? String(Math.floor(maxMargin))
                    : String(Number(maxMargin.toPrecision(6)))
                );
              }}
            >
              Max{" "}
              {maxMargin >= 1000
                ? Math.floor(maxMargin).toLocaleString()
                : Number(maxMargin.toPrecision(4))}
            </button>
          ) : null}
        </div>
        <div className="flex items-center gap-3">
          <input
            type="number"
            value={size}
            onChange={e => {
              maxPinnedRef.current = false;
              setSize(e.target.value);
            }}
            placeholder="0"
            className="min-w-0 flex-1 bg-transparent text-[26px] font-semibold tracking-tight text-white placeholder:text-white/20 focus:outline-none"
          />
          {marginChip}
        </div>
        <p className="mt-2 text-[11px] text-white/35">
          {direction === "long"
            ? `Balance ${walletTokens > 0 ? formatNumberCompact(walletTokens) : "0"} ${displayTicker}`
            : `Balance ${walletSol > 0 ? walletSol.toFixed(3) : "0"} SOL`}
        </p>
      </div>

      <LeverageRangeControl
        value={lockedLev}
        maxLev={maxLev}
        depthSol={reserveSol}
        onChange={v => setLeverage(clampLeverage(v, maxLev))}
      />

      <div className="space-y-0 px-0.5">
        <TalesTradeDetailsRow
          label={
            <LabelWithHint hint="Estimated mark price where this position can be liquidated. Moves with pool liquidity and your LTV.">
              Est. liquidation
            </LabelWithHint>
          }
          value={sizeNum > 0 ? formatTokenPriceUsd(liqPrice) : "—"}
        />
        <TalesTradeDetailsRow
          label="Position value"
          value={sizeNum > 0 ? formatUSD(previewPosValueUsd) : "—"}
        />
        {!isOneX ? (
          <TalesTradeDetailsRow
            label={
              <LabelWithHint hint="Highest leverage this pool’s current depth safely supports (Omnipair dynamic CF).">
                Max leverage
              </LabelWithHint>
            }
            value={`${maxLev.toFixed(1)}x`}
          />
        ) : null}
      </div>

      {!omnipairPoolSnapshot ? (
        <p className="px-0.5 text-[11px] text-amber-200/70">
          Waiting for Omnipair pool…
        </p>
      ) : null}

      {connected ? (
        <button
          type="button"
          onClick={handleOpen}
          disabled={loading || !size || !omnipairPoolSnapshot}
          className={cn(
            "w-full rounded-xl py-3.5 text-sm font-semibold transition-[filter] disabled:cursor-not-allowed disabled:opacity-45",
            direction === "long"
              ? "bg-emerald-500 text-[#04140a] hover:brightness-105"
              : "bg-red-500 text-white hover:brightness-105"
          )}
        >
          {loading
            ? "Opening…"
            : `${direction === "long" ? "Long" : "Short"} ${displayTicker}`}
        </button>
      ) : (
        <WalletMultiButton />
      )}
    </div>
  );
}

function formatNumberCompact(n: number): string {
  if (!(n > 0)) return "0";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1000) return Math.floor(n).toLocaleString();
  return Number(n.toPrecision(4)).toString();
}

function BorrowLtvSlider({
  ltvPct,
  maxBorrowPct,
  liqPct,
  onChange,
  depthSol,
}: {
  ltvPct: number;
  maxBorrowPct: number;
  liqPct: number;
  onChange: (pct: number) => void;
  depthSol: number;
}) {
  return (
    <TalesPoolRangeSlider
      label="Loan to value"
      labelHint="Debt ÷ collateral value. Higher LTV borrows more SOL but leaves less room before liquidation."
      value={ltvPct}
      min={1}
      max={maxBorrowPct}
      step={0.1}
      formatValue={v => `${v.toFixed(1)}%`}
      ariaLabel="Loan to value"
      onChange={onChange}
      footerLeft="1%"
      footerCenter={
        <>
          Pool max{" "}
          <span className="font-semibold text-white/80">
            {maxBorrowPct.toFixed(0)}%
          </span>
          {depthSol > 0 ? (
            <span className="text-white/35">
              {" "}
              · {depthSol < 1 ? "thin" : depthSol < 5 ? "moderate" : "deep"}{" "}
              {depthSol.toFixed(2)} SOL
            </span>
          ) : null}
        </>
      }
      footerRight={
        <span className="text-red-400/80">
          Liq <span className="font-semibold">{liqPct.toFixed(0)}%</span>
        </span>
      }
    />
  );
}

/* ─── Borrow ─────────────────────────────────────────────────────── */

function BorrowPanel({
  token,
  connected,
  omnipairPoolSnapshot,
}: {
  token: Token;
  connected: boolean;
  omnipairPoolSnapshot: OmnipairPoolSnapshot | null;
}) {
  const { connection } = useConnection();
  const walletAdapter = useWallet();
  const { solUsd } = useSolUsd();
  const [collateral, setCollateral] = useState("");
  const [ltvPct, setLtvPct] = useState(12);
  const [loading, setLoading] = useState(false);
  const {
    tokenBalanceRaw,
    tokenDecimals,
  } = useWalletBalances(connected ? token.mint : undefined);

  const collNum = parseFloat(collateral) || 0;
  const spot =
    omnipairPoolSnapshot?.spotPriceSol && omnipairPoolSnapshot.spotPriceSol > 0
      ? omnipairPoolSnapshot.spotPriceSol
      : token.currentPrice;
  const usd = solUsd ?? 140;
  const reserveSol = omnipairPoolSnapshot
    ? Number(omnipairPoolSnapshot.reserveSolRaw) / 1e9
    : 0;
  const reserveProjectUi = omnipairPoolSnapshot
    ? Number(omnipairPoolSnapshot.reserveProjectRaw) /
      10 ** Math.max(0, omnipairPoolSnapshot.projectTokenDecimals || 6)
    : 0;
  // Docs: Borrow CF = Liq CF × 0.95; thin pools use impact-aware CF ≪ 85%.
  const maxBorrowCf = poolSafeCf(reserveSol);
  const maxBorrowPct = Math.round(maxBorrowCf * 1000) / 10; // e.g. 22
  const liqPct = Math.min(85, Math.round((maxBorrowCf / 0.95) * 1000) / 10);

  useEffect(() => {
    setLtvPct(prev => Math.min(prev, maxBorrowPct));
  }, [maxBorrowPct]);

  const walletTokens =
    Number(tokenBalanceRaw || "0") / 10 ** Math.max(0, tokenDecimals || 6);
  const impactCap =
    reserveProjectUi > 0 ? reserveProjectUi * 0.12 : walletTokens;
  const maxCollateral = Math.min(
    walletTokens > 0 ? walletTokens * 0.98 : 0,
    impactCap
  );

  const collValueSol = collNum * spot;
  const collValueUsd = collValueSol * usd;
  const ltv = Math.min(ltvPct, maxBorrowPct) / 100;
  // Also don't request more SOL than thin-pool cash band.
  const poolBorrowCapSol = Math.max(0, reserveSol * 0.12);
  const borrowSolRaw = collValueSol * ltv;
  const borrowSol = Math.min(borrowSolRaw, poolBorrowCapSol);
  const priceUSD = spot * usd;
  // Debt SOL / (coll × liqCf) ≈ spot at liquidation (token price falls).
  const liqSpotSol =
    collNum > 0 && liqPct > 0 ? (borrowSol / collNum) / (liqPct / 100) : 0;
  const liqPriceUsd = liqSpotSol * usd;

  const displayTicker =
    token.ticker.length > 6 ? token.ticker.slice(0, 6) + "…" : token.ticker;

  const handleBorrow = async () => {
    if (!connected || !collateral || !omnipairPoolSnapshot) {
      toast.error("Connect wallet and wait for the Omnipair pool");
      return;
    }
    const coll = parseFloat(collateral);
    if (!(coll > 0)) {
      toast.error("Enter collateral amount");
      return;
    }
    if (Number.isFinite(maxCollateral) && coll > maxCollateral + 1e-9) {
      toast.error(
        `Max collateral for this pool is ${maxCollateral.toPrecision(4)} ${displayTicker}`
      );
      return;
    }
    if (!(borrowSol > 0)) {
      toast.error("Borrow amount too small — raise collateral or LTV");
      return;
    }
    setLoading(true);
    try {
      const wallet = {
        publicKey: walletAdapter.publicKey!,
        signTransaction: walletAdapter.signTransaction!.bind(walletAdapter),
        signAllTransactions: walletAdapter.signAllTransactions!.bind(walletAdapter),
      } as AnchorWallet;
      const { collateralSig, borrowSig } = await sendOmnipairBorrowAgainstProjectTx({
        connection,
        wallet,
        snapshot: omnipairPoolSnapshot,
        collateralTokenUi: coll,
        borrowSolUi: borrowSol,
      });
      toast.success(
        `Borrowed ${borrowSol.toFixed(4)} SOL @ ${ltvPct.toFixed(1)}% LTV`
      );
      console.info("[borrow]", { collateralSig, borrowSig, ltvPct, borrowSol });
      if (walletAdapter.publicKey) {
        upsertOpenPosition({
          mint: token.mint,
          wallet: walletAdapter.publicKey.toBase58(),
          kind: "loan",
          direction: "long",
          leverage: 0,
          marginUi: coll,
          entrySpotSol: spot,
          entrySolUsd: usd,
          signature: borrowSig,
          borrowSolUi: borrowSol,
        });
        void persistLaunchpadTrade({
          mint: token.mint,
          signature: borrowSig,
          side: "borrow",
          sol_amount_raw: BigInt(Math.floor(borrowSol * 1e9)).toString(),
          token_amount_raw: BigInt(
            Math.floor(
              coll *
                10 **
                  (omnipairPoolSnapshot?.projectTokenDecimals ?? 6)
            )
          ).toString(),
          timestamp: new Date().toISOString(),
          wallet: walletAdapter.publicKey.toBase58(),
          price_sol: spot,
          source: "omnipair",
        });
      }
      window.dispatchEvent(
        new CustomEvent("higher:trade-complete", {
          detail: {
            mint: token.mint,
            source: "omnipair-borrow",
            side: "borrow",
            signature: borrowSig,
          },
        })
      );
    } catch (e) {
      if (!isLikelyBenignWalletOrRpcNoise(e)) {
        toast.error(e instanceof Error ? e.message : String(e));
      }
    } finally {
      setLoading(false);
    }
  };

  const projectIcon = token.imageUrl?.trim() || null;

  return (
    <div className="space-y-2.5">
      <div className="flex items-center justify-between px-0.5 pt-0.5">
        <span className="text-[12px] font-medium text-white/45">
          <LabelWithHint hint="Isolated borrow: only this token’s collateral backs the SOL loan. Other positions stay separate.">
            Borrow SOL
          </LabelWithHint>
        </span>
        <span className="text-[11px] text-white/35">Isolated</span>
      </div>

      <div className="rounded-xl border border-white/[0.08] bg-white/[0.03] px-3.5 py-3">
        <div className="mb-2 flex items-center justify-between">
          <span className="text-[12px] font-medium text-white/45">You borrow</span>
        </div>
        <div className="flex items-center gap-3">
          <p className="min-w-0 flex-1 text-[26px] font-semibold tabular-nums tracking-tight text-white">
            {collNum > 0 ? borrowSol.toFixed(6) : "0"}
          </p>
          <SwapTokenChip symbol="SOL" iconUrl={SOL_TOKEN_ICON} />
        </div>
        <p className="mt-2 text-[11px] tabular-nums text-white/35">
          {collNum > 0 ? `≈ ${formatUSD(borrowSol * usd)}` : "—"}
        </p>
      </div>

      <div className="rounded-xl border border-white/[0.08] bg-white/[0.03] px-3.5 py-3">
        <div className="mb-2 flex items-center justify-between">
          <span className="text-[12px] font-medium text-white/45">Collateral</span>
          <button
            type="button"
            disabled={!(maxCollateral > 0)}
            onClick={() =>
              setCollateral(
                maxCollateral >= 1000
                  ? String(Math.floor(maxCollateral))
                  : String(Number(maxCollateral.toPrecision(6)))
              )
            }
            className="text-[11px] font-semibold text-white/50 hover:text-white disabled:opacity-40"
          >
            Max
          </button>
        </div>
        <div className="flex items-center gap-3">
          <input
            type="number"
            value={collateral}
            onChange={e => setCollateral(e.target.value)}
            placeholder="0"
            className="min-w-0 flex-1 bg-transparent text-[26px] font-semibold tabular-nums tracking-tight text-white placeholder:text-white/20 focus:outline-none"
          />
          <SwapTokenChip symbol={displayTicker} iconUrl={projectIcon} />
        </div>
        <div className="mt-2 flex items-center justify-between gap-2 text-[11px] text-white/35">
          <span className="tabular-nums">
            {collNum > 0 ? `≈ ${formatUSD(collValueUsd)}` : "—"}
          </span>
          <span className="tabular-nums">
            Balance{" "}
            {walletTokens > 0 ? formatNumberCompact(walletTokens) : "0"}
          </span>
        </div>
      </div>

      <BorrowLtvSlider
        ltvPct={Math.min(ltvPct, maxBorrowPct)}
        maxBorrowPct={maxBorrowPct}
        liqPct={liqPct}
        depthSol={reserveSol}
        onChange={setLtvPct}
      />

      {!omnipairPoolSnapshot ? (
        <p className="px-0.5 text-[10px] text-amber-200/70">Waiting for Omnipair pool…</p>
      ) : null}

      {connected ? (
        <button
          type="button"
          onClick={handleBorrow}
          disabled={loading || !(collNum > 0) || !(borrowSol > 0) || !omnipairPoolSnapshot}
          className="w-full rounded-lg bg-[#f4f4f5] py-3.5 text-sm font-semibold text-[#0a0a0a] transition-[filter] hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-45"
        >
          {loading
            ? "Borrowing…"
            : collNum > 0
              ? `Borrow ${borrowSol.toFixed(4)} SOL`
              : "Borrow SOL"}
        </button>
      ) : (
        <WalletMultiButton />
      )}

      {collNum > 0 && liqPriceUsd > 0 ? (
        <p className="px-0.5 pb-0.5 text-center text-[11px] leading-snug text-white/45">
          Liquidates at{" "}
          <span className="font-semibold tabular-nums text-red-400/90">
            {formatTokenPriceUsd(liqPriceUsd)}
          </span>
        </p>
      ) : null}
    </div>
  );
}
