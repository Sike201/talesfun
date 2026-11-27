"use client";

import { useState, useRef, useEffect, type ReactNode } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import type { AnchorWallet } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { AlertTriangle, ArrowDownUp } from "lucide-react";
import { Token } from "@/types";
import { cn, formatUSD, formatSolPerTokenPrice, formatTokenPriceUsd } from "@/lib/utils";
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
import WakeSlider from "@/components/ui/WakeSlider";
import {
  clampLeverage,
  MIN_LEVERAGE,
  poolMaxLeverage,
  poolSafeCf,
} from "@/lib/poolMaxLeverage";
import {
  listOpenPositions,
  markPositionValueUsd,
  upsertOpenPosition,
} from "@/lib/openPositions";

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
  label: string;
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

/* ── Leverage slider (WakeSlider, pool-CF capped max) ──────────────── */
function LeverageWakeControl({
  value,
  onChange,
  maxLev,
}: {
  value: number;
  onChange: (v: number) => void;
  maxLev: number;
}) {
  const hi = Math.max(MIN_LEVERAGE + 0.1, maxLev);
  return (
    <div className="px-0.5 py-1">
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <span className="text-[11px] font-medium text-white/45">Leverage</span>
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold tabular-nums text-white">
            {value.toFixed(1)}x
          </span>
          <button
            type="button"
            className="rounded-md border border-white/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-white/70 hover:border-white/35 hover:text-white"
            onClick={() => onChange(hi)}
          >
            Max {hi.toFixed(1)}x
          </button>
        </div>
      </div>
      <WakeSlider
        value={value}
        min={MIN_LEVERAGE}
        max={hi}
        step={0.1}
        bars={36}
        height={44}
        restHeight={10}
        gap={3}
        fillColor="#f4f4f5"
        trackColor="#27272a"
        crestColor="#a1a1aa"
        sensitivity={1.15}
        reach={7}
        skew={0.55}
        glide={0.22}
        smoothing={90}
        ariaLabel="Leverage"
        formatValue={v => `${v.toFixed(1)}x`}
        onChange={onChange}
      />
      <div className="mt-1 flex justify-between text-[10px] text-white/30">
        <span>{MIN_LEVERAGE.toFixed(1)}x</span>
        <span>Pool max {hi.toFixed(1)}x</span>
      </div>
    </div>
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
    { id: "leverage", label: "Leverage" },
    { id: "borrow", label: "Borrow" },
    { id: "swap", label: "Swap" },
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
    token.ticker.length > 6 ? token.ticker.slice(0, 6) + "…" : token.ticker;

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

  return (
    <div className="space-y-3">
      {/* Omnipair-style: You sell → flip → You receive */}
      <div className="relative space-y-2">
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
              className="min-w-0 flex-1 bg-transparent text-[28px] font-semibold tracking-tight text-white placeholder:text-white/20 focus:outline-none"
            />
            <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-white/10 bg-black/40 px-2.5 py-1.5 text-[13px] font-semibold text-white">
              {sellToken}
            </span>
          </div>
          <div className="mt-2 flex gap-1.5">
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

        <div className="absolute left-1/2 top-1/2 z-10 -translate-x-1/2 -translate-y-1/2">
          <button
            type="button"
            aria-label={`Flip tokens: sell ${receiveToken}, receive ${sellToken}`}
            disabled={loading}
            onClick={flipSide}
            className="flex size-9 items-center justify-center rounded-full border border-white/15 bg-[#141414] text-white/70 shadow-lg transition-colors hover:border-white/30 hover:text-white disabled:opacity-40"
          >
            <ArrowDownUp size={15} />
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
              className="min-w-0 flex-1 truncate text-[28px] font-semibold tracking-tight text-white/90"
            >
              {receiveEstimate}
            </span>
            <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-white/10 bg-black/40 px-2.5 py-1.5 text-[13px] font-semibold text-white">
              {receiveToken}
            </span>
          </div>
        </div>
      </div>

      <div className="rounded-xl border border-white/[0.07] bg-white/[0.02] px-3 py-2">
        <TalesTradeDetailsRow label="Rate" value={rateLabel} />
        <TalesTradeDetailsRow label="Swap fee" value="0.30%" />
        <div className="mt-1 flex justify-end border-t border-white/[0.06] pt-2">
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
  const safeCf = poolSafeCf(reserveSol);
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

  // Margin Max must use raw balance — locale strings like "194,659" parse as 194.
  const walletSol = solBalanceLamports / 1e9;
  const walletTokens =
    Number(tokenBalanceRaw || "0") / 10 ** Math.max(0, tokenDecimals || 6);

  // Lower leverage → less (or zero) borrow → larger allowed margin.
  // 1.0x: collateral only → ~full wallet. Higher lev: pool-depth caps margin.
  const borrowFraction = Math.max(0, lockedLev - 1) / Math.max(lockedLev, 1);
  const effectiveCf = Math.min(borrowFraction, safeCf);
  const maxPoolBorrowSol = Math.max(0.001, reserveSol * 0.12);
  const walletLongCap =
    walletTokens > 0 ? walletTokens * 0.98 : Number.POSITIVE_INFINITY;
  const poolLongCap =
    effectiveCf > 1e-8 && spot > 0
      ? maxPoolBorrowSol / (spot * effectiveCf * 0.9)
      : Number.POSITIVE_INFINITY;
  const maxLongMarginTokens = Math.min(walletLongCap, poolLongCap);
  const walletShortCap = Math.max(0, walletSol - 0.02);
  const poolShortCap =
    effectiveCf > 1e-8
      ? maxPoolBorrowSol / (effectiveCf * 0.85)
      : Number.POSITIVE_INFINITY;
  const maxShortMarginSol = Math.min(walletShortCap, poolShortCap);
  const maxMargin =
    direction === "short" ? maxShortMarginSol : maxLongMarginTokens;

  const displayTicker =
    token.ticker.length > 6 ? token.ticker.slice(0, 6) + "…" : token.ticker;

  // Keep selection inside pool max when depth / CF changes.
  useEffect(() => {
    setLeverage(prev => clampLeverage(prev, maxLev));
  }, [maxLev]);

  // If leverage rises and current margin exceeds the new Max, clamp the input.
  useEffect(() => {
    const n = parseFloat(size);
    if (!(n > 0) || !Number.isFinite(maxMargin)) return;
    if (n > maxMargin + 1e-12) {
      setSize(
        String(
          Number(maxMargin >= 1000 ? maxMargin.toFixed(0) : maxMargin.toPrecision(6))
        )
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only re-clamp when caps move
  }, [maxMargin, direction]);

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

  return (
    <div className="space-y-1">
      <TalesSegmentToggle
        tone="signed"
        options={[
          { id: "long" as const, label: "Long" },
          { id: "short" as const, label: "Short" },
        ]}
        value={direction}
        onChange={setDirection}
      />

      <div className="flex items-center justify-between px-0.5 pt-2">
        <span className="text-[10px] font-medium uppercase tracking-wider text-white/35">
          Isolated
        </span>
        <span className="text-[10px] text-white/40">
          Max {maxLev.toFixed(1)}x · CF {(safeCf * 100).toFixed(0)}% · {reserveSol > 0 ? `${reserveSol.toFixed(2)} SOL depth` : "awaiting pool"}
        </span>
      </div>

      {openPos ? (
        <div className="mx-0.5 mb-1 rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2.5">
          <div className="flex items-center justify-between gap-2">
            <span
              className={cn(
                "text-[11px] font-semibold uppercase tracking-wide",
                openPos.direction === "long" ? "text-emerald-400" : "text-red-400"
              )}
            >
              Open {openPos.direction} · {openPos.leverage.toFixed(1)}x locked
            </span>
            <button
              type="button"
              className="text-[10px] text-white/40 hover:text-white/70"
              onClick={() => setOpenPos(null)}
            >
              Dismiss
            </button>
          </div>
          <div className="mt-1.5 space-y-0.5">
            <TalesTradeDetailsRow
              label="Leverage"
              value={`${openPos.leverage.toFixed(1)}x`}
            />
            <TalesTradeDetailsRow
              label="Position value"
              value={formatUSD(openMark.markUsd)}
              valueClassName={
                openMark.markUsd < openMark.entryUsd
                  ? "text-red-400"
                  : openMark.markUsd > openMark.entryUsd
                    ? "text-emerald-400"
                    : undefined
              }
            />
            <TalesTradeDetailsRow
              label="Entry → mark"
              value={`${formatSolPerTokenPrice(openPos.entrySpotSol).replace(/ SOL$/, "")} → ${spot > 0 ? formatSolPerTokenPrice(spot) : "—"}`}
            />
          </div>
        </div>
      ) : null}

      <TalesTradeField
        label={direction === "long" ? "Margin (token)" : "Margin (SOL)"}
        suffix={direction === "long" ? displayTicker : "SOL"}
        headerRight={
          Number.isFinite(maxMargin) && maxMargin > 0 ? (
            <button
              type="button"
              className="text-[10px] font-semibold tabular-nums text-white/50 hover:text-white"
              onClick={() =>
                setSize(
                  String(
                    Number(
                      maxMargin >= 1000
                        ? maxMargin.toFixed(0)
                        : maxMargin.toPrecision(6)
                    )
                  )
                )
              }
            >
              Max{" "}
              {maxMargin >= 1000
                ? Math.floor(maxMargin).toLocaleString()
                : Number(maxMargin.toPrecision(4))}
            </button>
          ) : null
        }
      >
        <input
          type="number"
          value={size}
          onChange={e => setSize(e.target.value)}
          placeholder="0"
          className="w-full bg-transparent text-2xl font-semibold tracking-tight text-white placeholder:text-white/20 focus:outline-none"
        />
      </TalesTradeField>

      <LeverageWakeControl
        value={lockedLev}
        maxLev={maxLev}
        onChange={v => setLeverage(clampLeverage(v, maxLev))}
      />

      <div className="space-y-0 px-0.5 py-1">
        <TalesTradeDetailsRow
          label="Leverage"
          value={`${lockedLev.toFixed(1)}x`}
        />
        <TalesTradeDetailsRow
          label="Spot"
          value={spot > 0 ? formatSolPerTokenPrice(spot) : "—"}
        />
        <TalesTradeDetailsRow
          label="Est. liquidation"
          value={sizeNum > 0 ? formatTokenPriceUsd(liqPrice) : "—"}
        />
        <TalesTradeDetailsRow
          label="Position value"
          value={sizeNum > 0 ? formatUSD(previewPosValueUsd) : "—"}
        />
        <TalesTradeDetailsRow
          label="Pool depth"
          value={reserveSol > 0 ? `${reserveSol.toFixed(3)} SOL` : "—"}
        />
        <TalesTradeDetailsRow
          label="Max margin"
          value={
            Number.isFinite(maxMargin) && maxMargin > 0
              ? `${
                  maxMargin >= 1000
                    ? Math.floor(maxMargin).toLocaleString()
                    : Number(maxMargin.toPrecision(4))
                } ${direction === "short" ? "SOL" : displayTicker}`
              : "—"
          }
        />
      </div>

      {lockedLev >= Math.max(3, maxLev - 0.2) && maxLev >= 3 && (
        <div className="flex gap-2 px-0.5 py-1">
          <AlertTriangle size={12} className="mt-0.5 shrink-0 text-amber-300/80" />
          <p className="text-[10px] leading-relaxed text-white/40">
            Near pool max — keep margin small so borrow clears impact-aware CF.
          </p>
        </div>
      )}

      {!omnipairPoolSnapshot ? (
        <p className="px-0.5 text-[10px] text-amber-200/70">Waiting for Omnipair pool…</p>
      ) : null}

      {connected ? (
        <button
          type="button"
          onClick={handleOpen}
          disabled={loading || !size || !omnipairPoolSnapshot}
          className={cn(
            "mt-2 w-full rounded-lg py-3.5 text-sm font-semibold transition-[filter] disabled:cursor-not-allowed disabled:opacity-45",
            direction === "long"
              ? "bg-emerald-500 text-[#04140a] hover:brightness-105"
              : "bg-red-500 text-white hover:brightness-105"
          )}
        >
          {loading
            ? "Submitting…"
            : `${direction === "long" ? "Long" : "Short"} ${token.ticker}`}
        </button>
      ) : (
        <WalletMultiButton />
      )}
    </div>
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
  const [amount, setAmount] = useState("");
  const [loading, setLoading] = useState(false);

  const num = parseFloat(amount) || 0;
  const spot =
    omnipairPoolSnapshot?.spotPriceSol && omnipairPoolSnapshot.spotPriceSol > 0
      ? omnipairPoolSnapshot.spotPriceSol
      : token.currentPrice;
  const usd = solUsd ?? 140;
  // Docs: borrow limit ≈ coll × impact-aware CF × 0.95; thin pools often ≪ 85%.
  // Match thin-pool impact-aware CF used in sendOmnipairBorrowAgainstProjectTx / leverage.
  const maxBorrowSol = num * spot * 0.22;
  const priceUSD = spot * usd;

  const displayTicker =
    token.ticker.length > 6 ? token.ticker.slice(0, 6) + "…" : token.ticker;

  const handleBorrow = async () => {
    if (!connected || !amount || !omnipairPoolSnapshot) {
      toast.error("Connect wallet and wait for the Omnipair pool");
      return;
    }
    const coll = parseFloat(amount);
    if (!(coll > 0)) {
      toast.error("Enter collateral amount");
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
      });
      toast.success(`Borrowed SOL — collateral ${collateralSig.slice(0, 8)}…`);
      console.info("[borrow]", { collateralSig, borrowSig });
      if (walletAdapter.publicKey) {
        const borrowSol = coll * spot * 0.22;
        void persistLaunchpadTrade({
          mint: token.mint,
          signature: borrowSig,
          side: "borrow",
          sol_amount_raw: BigInt(Math.floor(borrowSol * 1e9)).toString(),
          token_amount_raw: BigInt(Math.floor(coll * 1e6)).toString(),
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

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 text-[10px] text-white/45">
        <OmnipairTabIcon mode="borrow" />
        Isolated borrow — post {displayTicker}, receive SOL (docs.omnipair.fi)
      </div>
      <TalesTradeField label="Collateral" suffix={displayTicker}>
        <input
          type="number"
          value={amount}
          onChange={e => setAmount(e.target.value)}
          placeholder="0"
          className="w-full bg-transparent text-2xl font-semibold tracking-tight text-white placeholder:text-white/20 focus:outline-none"
        />
      </TalesTradeField>

      <TalesTradeField label="You borrow" suffix="SOL">
        <span className="text-2xl font-semibold tracking-tight text-white">
          {num > 0 ? maxBorrowSol.toFixed(4) : "0"}
        </span>
      </TalesTradeField>

      <div className="rounded-xl border border-white/[0.07] bg-white/[0.02] px-3 py-2">
        <TalesTradeDetailsRow
          label="Collateral value"
          value={num > 0 ? formatUSD(num * priceUSD) : "—"}
        />
        <TalesTradeDetailsRow
          label="Available to borrow"
          value={num > 0 ? `${maxBorrowSol.toFixed(4)} SOL` : "—"}
        />
        <TalesTradeDetailsRow label="Preview LTV" value="~22% (thin-pool safe)" />
        <TalesTradeDetailsRow label="Protocol max CF" value="85% impact-aware" />
        <TalesTradeDetailsRow label="Market" value="Isolated pair" />
      </div>

      {!omnipairPoolSnapshot ? (
        <p className="text-[10px] leading-relaxed text-amber-200/80">
          Waiting for Omnipair pool snapshot…
        </p>
      ) : (
        <p className="text-[10px] leading-relaxed text-white/35">
          Submits on-chain add_collateral then borrow against this market&apos;s reserves.
        </p>
      )}

      {connected ? (
        <button
          type="button"
          onClick={handleBorrow}
          disabled={loading || !amount || !omnipairPoolSnapshot}
          className="w-full rounded-full bg-[#f4f4f5] py-3.5 text-sm font-semibold text-[#0a0a0a] transition-[filter] hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-45"
        >
          {loading ? "Borrowing…" : "Borrow SOL"}
        </button>
      ) : (
        <WalletMultiButton />
      )}
    </div>
  );
}
