"use client";

import { useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { ArrowDownUp } from "lucide-react";
import { PublicKey } from "@solana/web3.js";
import { BN } from "@coral-xyz/anchor";
import { Token } from "@/types";
import { cn } from "@/lib/utils";
import { useProgram } from "@/hooks/useProgram";
import toast from "react-hot-toast";

interface Props {
  token: Token;
}

export default function TradePanel({ token }: Props) {
  const { connected } = useWallet();
  const program = useProgram();
  const [mode, setMode] = useState<"buy" | "sell">("buy");
  const [amount, setAmount] = useState("");
  const [loading, setLoading] = useState(false);

  const solAmount = parseFloat(amount) || 0;
  const estimatedTokens = solAmount > 0 ? Math.floor(solAmount / token.currentPrice) : 0;

  const handleTrade = async () => {
    if (!connected || !program) {
      toast.error("Connect your wallet to trade");
      return;
    }
    if (!amount || solAmount <= 0) { toast.error("Enter an amount"); return; }

    setLoading(true);
    try {
      const mint = new PublicKey(token.mint);

      if (mode === "buy") {
        const solLamports = new BN(Math.floor(solAmount * 1e9));
        const minTokensOut = new BN(Math.floor(estimatedTokens * 0.99 * 1e6));

        console.log("[higher.run] buy:", { sol: solAmount, lamports: solLamports.toString(), mint: token.mint });
        const tx = await program.methods
          .buy(solLamports, minTokensOut)
          .accountsPartial({ mint })
          .rpc();

        console.log("[higher.run] buy TX confirmed:", tx);
        toast.success(`Bought ${token.ticker}! TX: ${tx.slice(0, 8)}...`);
      } else {
        const tokenRaw = new BN(Math.floor(solAmount * 1e6));
        const estSol = solAmount * token.currentPrice;
        const minSolOut = new BN(Math.floor(estSol * 0.99 * 1e9));

        console.log("[higher.run] sell:", { tokens: solAmount, raw: tokenRaw.toString(), mint: token.mint });
        const tx = await program.methods
          .sell(tokenRaw, minSolOut)
          .accountsPartial({ mint })
          .rpc();

        console.log("[higher.run] sell TX confirmed:", tx);
        toast.success(`Sold ${token.ticker}! TX: ${tx.slice(0, 8)}...`);
      }

      setAmount("");
    } catch (error) {
      console.error("[higher.run] Trade failed:", error);
      const msg = error instanceof Error ? error.message : "Trade failed";
      toast.error(msg.length > 120 ? msg.slice(0, 120) + "..." : msg);
    } finally {
      setLoading(false);
    }
  };

  const quickAmounts = mode === "buy" ? ["0.1", "0.5", "1", "5"] : ["25%", "50%", "75%", "100%"];

  return (
    <div className="p-4">
      {/* Toggle */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex bg-gray-100 rounded-xl p-1 flex-1">
          {(["buy", "sell"] as const).map(m => (
            <button
              key={m}
              onClick={() => { setMode(m); setAmount(""); }}
              className={cn(
                "flex-1 py-2 rounded-lg text-sm font-semibold transition-all capitalize",
                mode === m
                  ? m === "buy" ? "bg-green-500 text-white shadow-sm" : "bg-red-500 text-white shadow-sm"
                  : "text-gray-400"
              )}
            >
              {m}
            </button>
          ))}
        </div>
        <span className="text-[10px] text-gray-300 ml-3">1% fee</span>
      </div>

      {/* Input */}
      <div className="relative mb-2">
        <input
          type="number"
          value={amount}
          onChange={e => setAmount(e.target.value)}
          placeholder="0"
          className="w-full bg-gray-100 rounded-xl px-4 py-3 text-sm font-medium text-gray-900 placeholder:text-gray-300 focus:outline-none focus:ring-2 focus:ring-green-500/20 transition-all pr-16"
        />
        <span className="absolute right-4 top-1/2 -translate-y-1/2 text-xs font-semibold text-gray-400">
          {mode === "buy" ? "SOL" : token.ticker}
        </span>
      </div>

      {/* Quick amounts */}
      <div className="flex gap-1.5 mb-3">
        {quickAmounts.map(q => (
          <button
            key={q}
            onClick={() => setAmount(q.replace("%", ""))}
            className="flex-1 py-1.5 text-[10px] font-medium bg-gray-100 hover:bg-gray-200 text-gray-500 rounded-lg transition-colors"
          >
            {q}
          </button>
        ))}
      </div>

      {/* Estimate */}
      {amount && solAmount > 0 && (
        <div className="bg-gray-100 rounded-xl p-3 mb-3 text-xs text-gray-500">
          You will receive ~<span className="text-gray-900 font-medium ml-1">
            {mode === "buy"
              ? `${estimatedTokens.toLocaleString()} ${token.ticker}`
              : `${(solAmount * token.currentPrice).toFixed(4)} SOL`}
          </span>
        </div>
      )}

      {/* Action */}
      {connected ? (
        <button
          onClick={handleTrade}
          disabled={loading || !amount}
          className={cn(
            "w-full py-3 rounded-xl font-semibold text-sm transition-all",
            mode === "buy"
              ? "bg-green-500 hover:bg-green-600 text-white disabled:opacity-40"
              : "bg-red-500 hover:bg-red-600 text-white disabled:opacity-40"
          )}
        >
          {loading ? (
            <span className="flex items-center justify-center gap-2">
              <ArrowDownUp size={14} className="animate-spin" /> Processing...
            </span>
          ) : (
            `${mode === "buy" ? "Buy" : "Sell"} ${token.ticker}`
          )}
        </button>
      ) : (
        <WalletMultiButton />
      )}
    </div>
  );
}
