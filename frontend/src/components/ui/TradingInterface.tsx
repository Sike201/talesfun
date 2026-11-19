"use client";

import { useState, useRef, useEffect, type ReactNode } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import type { AnchorWallet } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { AlertTriangle } from "lucide-react";
import { Token } from "@/types";
import { cn, formatUSD } from "@/lib/utils";
import toast from "react-hot-toast";
import type { OmnipairPoolSnapshot } from "@/lib/omnipairPoolState";
import { sendOmnipairSwapTx, omnipairMaxBuySolUi } from "@/lib/omnipairSwap";
import { sendOmnipairAddLiquidityTx } from "@/lib/omnipairLiquidity";
import { useWalletBalances } from "@/hooks/useWalletBalances";
import { persistLaunchpadTrade } from "@/lib/persistLaunchpadTrade";

function isLikelyBenignWalletOrRpcNoise(e: unknown): boolean {
  const m = (e instanceof Error ? e.message : String(e)).toLowerCase();
  return (
    (m.includes("ws") && m.includes("undefined")) ||
    (m.includes("websocket") && m.includes("undefined"))
  );
}

type Mode = "swap" | "leverage" | "borrow" | "liquidity";

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
    <div className="grid grid-cols-2 gap-2">
      {options.map((opt, i) => {
        const active = value === opt.id;
        const signed =
          tone === "signed"
            ? i === 0
              ? active
                ? "border-emerald-400/50 bg-emerald-500/10 text-emerald-300"
                : "border-white/[0.08] text-white/40 hover:border-white/15"
              : active
                ? "border-red-400/50 bg-red-500/10 text-red-300"
                : "border-white/[0.08] text-white/40 hover:border-white/15"
            : active
              ? "border-white/20 bg-white/[0.08] text-white"
              : "border-white/[0.08] text-white/40 hover:border-white/15";
        return (
          <button
            key={opt.id}
            type="button"
            disabled={disabled}
            onClick={() => onChange(opt.id)}
            className={cn(
              "rounded-xl border px-2 py-3 text-sm font-semibold transition-colors disabled:opacity-50",
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
    <div className="rounded-2xl border border-white/[0.07] bg-black/35 px-3.5 py-3.5">
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <span className="text-[11px] font-medium text-white/45">{label}</span>
        <div className="flex items-center gap-2">
          {headerRight}
          {suffix ? (
            <span className="max-w-[80px] truncate text-[11px] font-semibold text-white/50">
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
  value: string;
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

/* ── Leverage slider ───────────────────────────────────────────────── */
function LeverageSlider({
  value,
  onChange,
}: {
  value: number;
  onChange: (v: number) => void;
}) {
  const pct = ((value - 1) / 9) * 100;
  return (
    <div className="rounded-xl bg-white/[0.035] px-3.5 py-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-[11px] font-medium text-white/45">Leverage</span>
        <span className="text-sm font-bold tabular-nums text-white">{value}x</span>
      </div>
      <input
        type="range"
        min={1}
        max={10}
        step={1}
        value={value}
        onChange={e => onChange(parseInt(e.target.value))}
        className="h-1.5 w-full cursor-pointer appearance-none rounded-full"
        style={{
          background: `linear-gradient(to right, rgba(200,230,255,0.7) 0%, rgba(200,230,255,0.7) ${pct}%, rgba(255,255,255,0.12) ${pct}%, rgba(255,255,255,0.12) 100%)`,
          accentColor: "#a1a1aa",
        }}
      />
      <div className="mt-2 flex justify-between text-[10px] text-white/35">
        {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(l => (
          <button
            key={l}
            type="button"
            onClick={() => onChange(l)}
            className={cn(
              "transition-colors",
              value === l ? "font-semibold text-white" : "hover:text-white/60"
            )}
          >
            {l}x
          </button>
        ))}
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
    { id: "liquidity", label: "Earn" },
  ];

  return (
    <div className="overflow-hidden rounded-2xl border border-white/[0.07] bg-[#111111]">
      <div className="flex gap-1 overflow-x-auto border-b border-white/[0.06] px-2 pt-2 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {tabs.map(t => (
          <button
            key={t.id}
            type="button"
            onClick={() => setMode(t.id)}
            className={cn(
              "shrink-0 rounded-t-lg px-3.5 py-2.5 text-[12px] font-semibold transition-colors",
              mode === t.id
                ? "bg-white/[0.08] text-white"
                : "text-white/40 hover:text-white/70"
            )}
          >
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
          />
        ) : null}
        {mode === "borrow" ? (
          <BorrowPanel token={token} connected={connected} />
        ) : null}
        {mode === "liquidity" ? (
          <OmnipairLiquidityPanel
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
  const [slippage, setSlippage] = useState("5");
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

  return (
    <div className="space-y-3">
      <TalesSegmentToggle
        tone="signed"
        options={[
          { id: "buy" as const, label: "Buy" },
          { id: "sell" as const, label: "Sell" },
        ]}
        value={side}
        disabled={loading}
        onChange={s => {
          setSide(s);
          setAmount("");
        }}
      />

      <div className="rounded-xl border border-white/[0.07] bg-white/[0.02] px-3 py-2">
        <TalesTradeDetailsRow
          label="Available"
          value={
            walletBalLoading
              ? "…"
              : side === "buy"
                ? `${spendableSol.toFixed(4)} SOL`
                : `${tokenBalUi.toLocaleString(undefined, { maximumFractionDigits: 4 })} ${displayTicker}`
          }
        />
        <TalesTradeDetailsRow
          label="Venue"
          value={omnipairPoolSnapshot ? "Omnipair spot" : "Estimate"}
        />
      </div>

      <TalesTradeField
        label={side === "buy" ? `Buy ${token.ticker}` : `Sell ${token.ticker}`}
        suffix={side === "buy" ? "SOL" : displayTicker}
        headerRight={
          <button
            type="button"
            disabled={loading || (omnipairPoolSnapshot != null && walletBalLoading)}
            onClick={() => {
              if (omnipairPoolSnapshot) applyOmnipairQuickPercent(100);
              else setAmount("100");
            }}
            className="text-[10px] font-semibold text-white/50 hover:text-white disabled:opacity-40"
          >
            Max
          </button>
        }
      >
        <input
          type="number"
          value={amount}
          onChange={e => setAmount(e.target.value)}
          placeholder="0"
          className="w-full bg-transparent text-2xl font-semibold tracking-tight text-white placeholder:text-white/20 focus:outline-none"
        />
        {num > 0 ? (
          <p className="mt-2 text-xs text-white/40">
            ↓{" "}
            <span className="font-medium text-white/75">
              {side === "buy"
                ? `${estimated.toLocaleString()} ${token.ticker}`
                : `${estimated.toFixed(4)} SOL`}
            </span>
          </p>
        ) : null}
      </TalesTradeField>

      <div className="flex gap-1.5">
        {([25, 50, 100] as const).map(pct => (
          <button
            key={pct}
            type="button"
            disabled={loading || (omnipairPoolSnapshot != null && walletBalLoading)}
            onClick={() => {
              if (omnipairPoolSnapshot) applyOmnipairQuickPercent(pct);
              else setAmount(String(pct));
            }}
            className="flex-1 rounded-lg border border-white/10 bg-black/30 py-1.5 text-[10px] font-semibold text-white/50 transition-colors hover:border-white/20 hover:text-white/80 disabled:pointer-events-none disabled:opacity-40"
          >
            {pct}%
          </button>
        ))}
      </div>

      <div className="rounded-xl border border-white/[0.07] bg-white/[0.02] px-3 py-2">
        <TalesTradeDetailsRow
          label="You pay"
          value={
            num > 0
              ? side === "buy"
                ? `${num} SOL`
                : `${num} ${displayTicker}`
              : "—"
          }
        />
        <TalesTradeDetailsRow
          label="You receive"
          value={
            num > 0
              ? side === "buy"
                ? `~${estimated.toLocaleString()} ${token.ticker}`
                : `~${estimated.toFixed(4)} SOL`
              : "—"
          }
        />
        <div className="flex justify-end border-t border-white/[0.06] pt-2 mt-1">
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
          className="w-full rounded-full bg-[#f4f4f5] py-3.5 text-sm font-semibold text-[#0a0a0a] transition-[filter] hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-45"
        >
          {loading && omnipairPoolSnapshot
            ? "Swapping…"
            : loading
              ? "Processing…"
              : side === "buy"
                ? `Buy ${token.ticker}`
                : `Sell ${token.ticker}`}
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
}: {
  token: Token;
  connected: boolean;
  initialDirection?: "long" | "short";
}) {
  const [direction, setDirection] = useState<"long" | "short">(
    initialDirection ?? "long"
  );
  const [size, setSize] = useState("");
  const [leverage, setLeverage] = useState(1);
  const [loading, setLoading] = useState(false);

  const sizeNum = parseFloat(size) || 0;
  const positionSize = sizeNum * leverage;
  const currentPriceUSD = token.currentPrice * 140;
  const liqPrice =
    direction === "long"
      ? currentPriceUSD * (1 - 1 / Math.max(leverage, 1.1) + 0.05)
      : currentPriceUSD * (1 + 1 / Math.max(leverage, 1.1) - 0.05);

  const displayTicker =
    token.ticker.length > 6 ? token.ticker.slice(0, 6) + "…" : token.ticker;

  const handleOpen = async () => {
    if (!connected || !size) return;
    setLoading(true);
    await new Promise(r => setTimeout(r, 400));
    toast.error(
      `Long/short txs are next — Omnipair pool is live for swap. See Docs → Leveraging.`
    );
    setLoading(false);
  };

  return (
    <div className="space-y-3">
      <TalesSegmentToggle
        tone="signed"
        options={[
          { id: "long" as const, label: "Long" },
          { id: "short" as const, label: "Short" },
        ]}
        value={direction}
        onChange={setDirection}
      />

      <div className="flex items-center justify-between px-0.5">
        <span className="rounded-md border border-white/10 bg-white/[0.04] px-2 py-0.5 text-[10px] font-semibold text-white/50">
          Isolated
        </span>
        <span className="text-[10px] font-medium text-white/45">{leverage}x leverage</span>
      </div>

      <div className="rounded-xl border border-white/[0.07] bg-white/[0.02] px-3 py-2">
        <TalesTradeDetailsRow
          label="Available to trade"
          value={`0.00 ${direction === "long" ? "SOL" : displayTicker}`}
        />
        <TalesTradeDetailsRow
          label="Current position"
          value={`0.00 ${displayTicker}`}
        />
      </div>

      <TalesTradeField label="Size" suffix={displayTicker}>
        <input
          type="number"
          value={size}
          onChange={e => setSize(e.target.value)}
          placeholder="0"
          className="w-full bg-transparent text-2xl font-semibold tracking-tight text-white placeholder:text-white/20 focus:outline-none"
        />
      </TalesTradeField>

      <LeverageSlider value={leverage} onChange={setLeverage} />

      <div className="rounded-xl border border-white/[0.07] bg-white/[0.02] px-3 py-2">
        <TalesTradeDetailsRow
          label="Liquidation price"
          value={sizeNum > 0 ? `$${liqPrice.toFixed(6)}` : "N/A"}
        />
        <TalesTradeDetailsRow
          label="Order value"
          value={sizeNum > 0 ? formatUSD(positionSize * currentPriceUSD) : "N/A"}
        />
        <TalesTradeDetailsRow label="Slippage (max)" value="8.00%" />
      </div>

      {leverage >= 5 && (
        <div className="flex gap-2 rounded-xl border border-amber-500/25 bg-amber-500/10 px-3 py-2.5">
          <AlertTriangle size={12} className="mt-0.5 shrink-0 text-amber-300" />
          <p className="text-[10px] leading-relaxed text-amber-100/90">
            High leverage. Liquidation at about {(100 / leverage).toFixed(0)}% adverse move.
          </p>
        </div>
      )}

      <p className="text-[10px] leading-relaxed text-white/35">
        Long/short txs coming next — spot swap works now on Omnipair.
      </p>

      {connected ? (
        <button
          type="button"
          onClick={handleOpen}
          disabled={loading || !size}
          className={cn(
            "w-full rounded-full py-3.5 text-sm font-semibold transition-[filter] disabled:cursor-not-allowed disabled:opacity-45",
            direction === "long"
              ? "bg-emerald-500 text-[#04140a] hover:brightness-105"
              : "bg-red-500 text-white hover:brightness-105"
          )}
        >
          {loading ? "Opening…" : `${direction === "long" ? "Long" : "Short"} ${token.ticker}`}
        </button>
      ) : (
        <WalletMultiButton />
      )}
    </div>
  );
}

/* ─── Borrow ─────────────────────────────────────────────────────── */

function BorrowPanel({ token, connected }: { token: Token; connected: boolean }) {
  const [amount, setAmount] = useState("");
  const [loading, setLoading] = useState(false);

  const num = parseFloat(amount) || 0;
  const maxBorrow = num * 0.65;
  const priceUSD = token.currentPrice * 140;

  const displayTicker =
    token.ticker.length > 6 ? token.ticker.slice(0, 6) + "…" : token.ticker;

  const handleBorrow = async () => {
    if (!connected || !amount) return;
    setLoading(true);
    await new Promise(r => setTimeout(r, 400));
    toast.error(
      `Borrow txs are next — post collateral via Omnipair once wired. See Docs → Borrowing.`
    );
    setLoading(false);
  };

  return (
    <div className="space-y-3">
      <TalesTradeField label="Collateral" suffix={displayTicker}>
        <input
          type="number"
          value={amount}
          onChange={e => setAmount(e.target.value)}
          placeholder="0"
          className="w-full bg-transparent text-2xl font-semibold tracking-tight text-white placeholder:text-white/20 focus:outline-none"
        />
      </TalesTradeField>

      <TalesTradeField label="Receive" suffix="SOL">
        <span className="text-2xl font-semibold tracking-tight text-white">
          {num > 0 ? ((maxBorrow * priceUSD) / 140).toFixed(4) : "0"}
        </span>
      </TalesTradeField>

      <div className="rounded-xl border border-white/[0.07] bg-white/[0.02] px-3 py-2">
        <TalesTradeDetailsRow
          label="Collateral value"
          value={num > 0 ? formatUSD(num * priceUSD) : "—"}
        />
        <TalesTradeDetailsRow
          label="Available to borrow"
          value={num > 0 ? formatUSD(maxBorrow * priceUSD) : "—"}
        />
        <TalesTradeDetailsRow label="Interest rate" value="6.5% APR" />
        <TalesTradeDetailsRow label="Max LTV" value="65%" />
        <TalesTradeDetailsRow label="Liquidation at" value="−40% from entry" />
      </div>

      <p className="text-[10px] leading-relaxed text-white/35">
        Borrow submits via Omnipair next — UI is ready.
      </p>

      {connected ? (
        <button
          type="button"
          onClick={handleBorrow}
          disabled={loading || !amount}
          className="w-full rounded-full bg-[#f4f4f5] py-3.5 text-sm font-semibold text-[#0a0a0a] transition-[filter] hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-45"
        >
          {loading ? "Processing…" : "Borrow SOL"}
        </button>
      ) : (
        <WalletMultiButton />
      )}
    </div>
  );
}
