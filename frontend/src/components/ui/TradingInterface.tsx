"use client";

import { useState, useRef, useEffect } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { AlertTriangle } from "lucide-react";
import { Token } from "@/types";
import { cn, formatUSD } from "@/lib/utils";
import toast from "react-hot-toast";

type Mode = "swap" | "leverage" | "borrow";

interface Props {
  token: Token;
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
        onClick={() => { setDraft(value); setOpen(o => !o); }}
        className="text-[11px] text-gray-500 bg-gray-100 hover:bg-gray-200 px-2.5 py-1 rounded-full font-medium transition-colors"
      >
        Slippage: {value}%
      </button>

      {open && (
        <div className="absolute right-0 top-8 z-20 bg-white rounded-xl shadow-lg border border-gray-100 p-4 w-60">
          <p className="text-sm font-semibold text-gray-900 mb-1">Set max. slippage (%)</p>
          <p className="text-xs text-gray-400 mb-3 leading-relaxed">
            Max slippage you are willing to accept when placing trades.
          </p>
          <input
            type="number"
            value={draft}
            onChange={e => setDraft(e.target.value)}
            onKeyDown={e => e.key === "Enter" && commit()}
            autoFocus
            className="w-full bg-gray-100 rounded-lg px-3 py-2 text-sm font-medium text-gray-900 focus:outline-none mb-3"
          />
          <button
            onClick={commit}
            className="w-full bg-gray-900 text-white rounded-lg py-2 text-sm font-semibold hover:bg-gray-800 transition-colors"
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
    <div>
      <div className="flex items-center justify-between mb-2">
        <span className="text-[11px] text-gray-400">Leverage</span>
        <span className="text-sm font-bold text-gray-800">{value}x</span>
      </div>
      <div className="relative">
        <input
          type="range"
          min={1}
          max={10}
          step={1}
          value={value}
          onChange={e => onChange(parseInt(e.target.value))}
          className="w-full h-1.5 rounded-full appearance-none cursor-pointer"
          style={{
            background: `linear-gradient(to right, #374151 0%, #374151 ${pct}%, #E5E7EB ${pct}%, #E5E7EB 100%)`,
            accentColor: "#374151",
          }}
        />
      </div>
      <div className="flex justify-between text-[10px] text-gray-400 mt-1.5">
        {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(l => (
          <span
            key={l}
            onClick={() => onChange(l)}
            className={cn("cursor-pointer transition-colors", value === l ? "text-gray-800 font-semibold" : "hover:text-gray-600")}
          >
            {l}x
          </span>
        ))}
      </div>
    </div>
  );
}

/* ── Root component ────────────────────────────────────────────────── */

export default function TradingInterface({ token }: Props) {
  const { connected } = useWallet();
  const [mode, setMode] = useState<Mode>("swap");

  return (
    <div className="bg-white rounded-lg overflow-hidden">
      {/* Mode selector */}
      <div className="flex items-center bg-gray-100 rounded-lg m-4 p-1 gap-1">
        {(["swap", "leverage", "borrow"] as const).map(m => (
          <button
            key={m}
            onClick={() => setMode(m)}
            className={cn(
              "flex-1 py-2 rounded-md text-xs font-semibold transition-all",
              mode === m ? "bg-white text-gray-900 shadow-sm" : "text-gray-400 hover:text-gray-600"
            )}
          >
            {m === "leverage" ? "Leverage" : m === "borrow" ? "Borrow" : "Swap"}
          </button>
        ))}
      </div>

      <div className="px-4 pb-4">
        {mode === "swap"     && <SwapPanel     token={token} connected={connected} />}
        {mode === "leverage" && <LeveragePanel token={token} connected={connected} />}
        {mode === "borrow"   && <BorrowPanel   token={token} connected={connected} />}
      </div>
    </div>
  );
}

/* ─── Swap ───────────────────────────────────────────────────────── */

function SwapPanel({ token, connected }: { token: Token; connected: boolean }) {
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [amount, setAmount] = useState("");
  const [slippage, setSlippage] = useState("5");
  const [loading, setLoading] = useState(false);

  const num = parseFloat(amount) || 0;
  const estimated =
    side === "buy"
      ? num > 0 ? Math.floor(num / token.currentPrice) : 0
      : num * token.currentPrice;

  const displayTicker =
    token.ticker.length > 6 ? token.ticker.slice(0, 6) + "…" : token.ticker;

  const handleTrade = async () => {
    if (!connected || !amount) return;
    setLoading(true);
    await new Promise(r => setTimeout(r, 1200));
    toast.success(`${side === "buy" ? "Bought" : "Sold"} ${token.ticker}`);
    setAmount("");
    setLoading(false);
  };

  return (
    <div className="space-y-3">
      {/* Buy / Sell — glass toggle */}
      <div className="relative flex bg-gray-100 rounded-lg p-1">
        {/* glass sliding pill */}
        <div
          className="absolute top-1 bottom-1 rounded-md transition-all duration-300 ease-[cubic-bezier(0.34,1.56,0.64,1)]"
          style={{
            width: "calc(50% - 4px)",
            left: side === "buy" ? "4px" : "calc(50%)",
            background: side === "buy"
              ? "linear-gradient(-75deg, rgba(255,255,255,0.08), rgba(34,197,94,0.13), rgba(255,255,255,0.06))"
              : "linear-gradient(-75deg, rgba(255,255,255,0.08), rgba(239,68,68,0.13), rgba(255,255,255,0.06))",
            boxShadow: "inset 0 1.5px 1.5px rgba(0,0,0,0.04), inset 0 -1.5px 1.5px rgba(255,255,255,0.6), 0 1px 6px rgba(0,0,0,0.08), inset 0 0 0 1.5px rgba(255,255,255,0.35)",
            backdropFilter: "blur(3px)",
            WebkitBackdropFilter: "blur(3px)",
          }}
        />
        {(["buy", "sell"] as const).map(s => (
          <button
            key={s}
            onClick={() => { setSide(s); setAmount(""); }}
            className={cn(
              "relative flex-1 py-2.5 rounded-md text-sm font-semibold transition-colors duration-200 z-10",
              side === s
                ? s === "buy" ? "text-green-800" : "text-red-800"
                : "text-gray-400"
            )}
          >
            {s === "buy" ? "Buy" : "Sell"}
          </button>
        ))}
      </div>

      {/* Slippage */}
      <div className="flex items-center justify-end">
        <SlippageButton value={slippage} onChange={setSlippage} />
      </div>

      {/* Amount input */}
      <div className="bg-gray-100 rounded-lg p-3">
        <div className="flex items-center justify-between mb-1">
          <span className="text-[11px] text-gray-400">Amount</span>
          <button onClick={() => setAmount("100")} className="text-[10px] text-gray-500 font-semibold hover:text-gray-700">
            Max
          </button>
        </div>
        <div className="flex items-center gap-2 min-w-0">
          <input
            type="number"
            value={amount}
            onChange={e => setAmount(e.target.value)}
            placeholder="0"
            className="flex-1 min-w-0 bg-transparent text-xl font-semibold text-gray-900 placeholder:text-gray-300 focus:outline-none"
          />
          <span className="text-sm font-semibold text-gray-400 flex-shrink-0 max-w-[60px] truncate">
            {side === "buy" ? "SOL" : displayTicker}
          </span>
        </div>
      </div>

      {/* Quick amounts — always 25 / 50 / 100% */}
      <div className="flex gap-1.5">
        {["25%", "50%", "100%"].map(q => (
          <button
            key={q}
            onClick={() => setAmount(q.replace("%", ""))}
            className="flex-1 py-1.5 text-[10px] font-medium bg-gray-100 hover:bg-gray-200 text-gray-500 rounded-md transition-colors"
          >
            {q}
          </button>
        ))}
      </div>

      {/* Receive estimate */}
      <p className="text-xs text-gray-400 min-h-[18px]">
        {num > 0 ? (
          <>You will receive ~<span className="text-gray-700 font-medium">
            {side === "buy"
              ? `${estimated.toLocaleString()} ${token.ticker}`
              : `${typeof estimated === "number" ? estimated.toFixed(4) : "0"} SOL`}
          </span></>
        ) : null}
      </p>

      {/* CTA */}
      {connected ? (
        <button
          onClick={handleTrade}
          disabled={loading || !amount}
          className="glass-trade-btn"
        >
          {loading ? "Processing…" : side === "buy" ? `Buy ${token.ticker}` : `Sell ${token.ticker}`}
        </button>
      ) : (
        <WalletMultiButton />
      )}
    </div>
  );
}

/* ─── Leverage ───────────────────────────────────────────────────── */

function LeveragePanel({ token, connected }: { token: Token; connected: boolean }) {
  const [direction, setDirection] = useState<"long" | "short">("long");
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
    await new Promise(r => setTimeout(r, 1500));
    toast.success(`Opened ${leverage}x ${direction} on ${token.ticker}`);
    setSize("");
    setLoading(false);
  };

  return (
    <div className="space-y-3">
      {/* Isolated + leverage label */}
      <div className="flex items-center justify-between">
        <span className="text-[10px] font-semibold text-gray-400 bg-gray-100 px-2 py-0.5 rounded">Isolated</span>
        <span className="text-[10px] text-gray-400">{leverage}x leverage</span>
      </div>

      {/* Long / Short — glass toggle */}
      <div className="relative flex bg-gray-100 rounded-lg p-1">
        <div
          className="absolute top-1 bottom-1 rounded-md transition-all duration-300 ease-[cubic-bezier(0.34,1.56,0.64,1)]"
          style={{
            width: "calc(50% - 4px)",
            left: direction === "long" ? "4px" : "calc(50%)",
            background: direction === "long"
              ? "linear-gradient(-75deg, rgba(255,255,255,0.08), rgba(34,197,94,0.13), rgba(255,255,255,0.06))"
              : "linear-gradient(-75deg, rgba(255,255,255,0.08), rgba(239,68,68,0.13), rgba(255,255,255,0.06))",
            boxShadow: "inset 0 1.5px 1.5px rgba(0,0,0,0.04), inset 0 -1.5px 1.5px rgba(255,255,255,0.6), 0 1px 6px rgba(0,0,0,0.08), inset 0 0 0 1.5px rgba(255,255,255,0.35)",
            backdropFilter: "blur(3px)",
            WebkitBackdropFilter: "blur(3px)",
          }}
        />
        <button
          onClick={() => setDirection("long")}
          className={cn("relative flex-1 py-2.5 rounded-md text-sm font-semibold transition-colors duration-200 z-10",
            direction === "long" ? "text-green-800" : "text-gray-400")}
        >
          Long
        </button>
        <button
          onClick={() => setDirection("short")}
          className={cn("relative flex-1 py-2.5 rounded-md text-sm font-semibold transition-colors duration-200 z-10",
            direction === "short" ? "text-red-800" : "text-gray-400")}
        >
          Short
        </button>
      </div>

      {/* Available / Position */}
      <div className="space-y-1 text-xs">
        <div className="flex justify-between">
          <span className="text-gray-400">Available to Trade</span>
          <span className="text-gray-700">0.00 {direction === "long" ? "SOL" : displayTicker}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-gray-400">Current Position</span>
          <span className="text-gray-700">0.00 {displayTicker}</span>
        </div>
      </div>

      {/* Size input */}
      <div className="bg-gray-100 rounded-lg p-3">
        <div className="flex items-center justify-between mb-1">
          <span className="text-[11px] text-gray-400">Size</span>
          <span className="text-[11px] text-gray-400 truncate max-w-[60px]">{displayTicker}</span>
        </div>
        <input
          type="number"
          value={size}
          onChange={e => setSize(e.target.value)}
          placeholder="0"
          className="w-full bg-transparent text-xl font-semibold text-gray-900 placeholder:text-gray-300 focus:outline-none"
        />
      </div>

      {/* Leverage slider */}
      <LeverageSlider value={leverage} onChange={setLeverage} />

      {/* Position details */}
      <div className="space-y-1.5 text-xs pt-2 border-t border-gray-100">
        <div className="flex justify-between">
          <span className="text-gray-400">Liquidation Price</span>
          <span className={sizeNum > 0 ? "text-gray-700 font-medium" : "text-gray-400"}>
            {sizeNum > 0 ? `$${liqPrice.toFixed(6)}` : "N/A"}
          </span>
        </div>
        <div className="flex justify-between">
          <span className="text-gray-400">Order Value</span>
          <span className="text-gray-600">{sizeNum > 0 ? formatUSD(positionSize * currentPriceUSD) : "N/A"}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-gray-400">Slippage (max)</span>
          <span className="text-gray-600">8.00%</span>
        </div>
      </div>

      {leverage >= 5 && (
        <div className="flex gap-2 bg-yellow-50 rounded-lg p-2.5">
          <AlertTriangle size={12} className="text-yellow-500 flex-shrink-0 mt-0.5" />
          <p className="text-[10px] text-yellow-700">
            High leverage. Liquidation at {(100 / leverage).toFixed(0)}% adverse move.
          </p>
        </div>
      )}

      {/* CTA */}
      {connected ? (
        <button
          onClick={handleOpen}
          disabled={loading || !size}
          className="glass-trade-btn"
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
    await new Promise(r => setTimeout(r, 1200));
    toast.success(`Borrowed SOL against ${token.ticker}`);
    setAmount("");
    setLoading(false);
  };

  return (
    <div className="space-y-3">
      {/* Collateral input */}
      <div className="bg-gray-100 rounded-lg p-3">
        <div className="flex items-center justify-between mb-1">
          <span className="text-[11px] text-gray-400">Collateral</span>
          <span className="text-[11px] text-gray-400 truncate max-w-[60px]">{displayTicker}</span>
        </div>
        <input
          type="number"
          value={amount}
          onChange={e => setAmount(e.target.value)}
          placeholder="0"
          className="w-full bg-transparent text-xl font-semibold text-gray-900 placeholder:text-gray-300 focus:outline-none"
        />
      </div>

      {/* Receive output */}
      <div className="bg-gray-100 rounded-lg p-3">
        <span className="text-[11px] text-gray-400 block mb-1">Receive SOL</span>
        <div className="flex items-baseline gap-2">
          <span className="text-xl font-semibold text-gray-900">
            {num > 0 ? (maxBorrow * priceUSD / 140).toFixed(4) : "0"}
          </span>
          <span className="text-sm text-gray-400 font-medium">SOL</span>
        </div>
      </div>

      {/* Details */}
      <div className="space-y-1.5 text-xs pt-2 border-t border-gray-100">
        <div className="flex justify-between">
          <span className="text-gray-400">Collateral Value</span>
          <span className="text-gray-700">{num > 0 ? formatUSD(num * priceUSD) : "—"}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-gray-400">Available to Borrow</span>
          <span className="text-gray-700 font-medium">{num > 0 ? formatUSD(maxBorrow * priceUSD) : "—"}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-gray-400">Interest Rate</span>
          <span className="text-gray-600">6.5% APR</span>
        </div>
        <div className="flex justify-between">
          <span className="text-gray-400">Max LTV</span>
          <span className="text-gray-600">65%</span>
        </div>
        <div className="flex justify-between">
          <span className="text-gray-400">Liquidation at</span>
          <span className="text-gray-600">−40% from entry</span>
        </div>
      </div>

      {/* CTA */}
      {connected ? (
        <button
          onClick={handleBorrow}
          disabled={loading || !amount}
          className="glass-trade-btn"
        >
          {loading ? "Processing…" : "Borrow SOL"}
        </button>
      ) : (
        <WalletMultiButton />
      )}
    </div>
  );
}
