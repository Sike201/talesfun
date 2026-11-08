"use client";

import { useState, useEffect } from "react";
import { useWallet, useConnection } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { PublicKey } from "@solana/web3.js";
import Link from "next/link";
import Image from "next/image";
import {
  BadgeDollarSign, TrendingUp, Download, ExternalLink, ArrowRight,
  Zap, Copy, Share2
} from "lucide-react";
import { MOCK_TOKENS } from "@/lib/mockData";
import { Token } from "@/types";
import { formatUSD, shortenAddress, timeAgo, calcBondingCurveProgress } from "@/lib/utils";
import { cn } from "@/lib/utils";
import { useProgram } from "@/hooks/useProgram";
import { getReadOnlyProgram, tokenStateToToken } from "@/lib/program";
import { enrichTokensWithMetadata } from "@/lib/metadata";
import toast from "react-hot-toast";

export default function DashboardPage() {
  const { connected, publicKey } = useWallet();
  const { connection } = useConnection();
  const program = useProgram();
  const [claiming, setClaiming] = useState<string | null>(null);
  const [tab, setTab] = useState<"all" | "graduated" | "active">("all");
  const [onChainTokens, setOnChainTokens] = useState<Token[] | null>(null);

  // Fetch tokens created by this wallet from chain
  useEffect(() => {
    if (!publicKey || !connection) return;
    let cancelled = false;
    async function fetchMyTokens() {
      try {
        const ro = getReadOnlyProgram(connection);
        const all = await (ro.account as any).tokenState.all();
        const mine = all
          .filter((a: { account: { creator: PublicKey } }) => a.account.creator.equals(publicKey!))
          .map((a: { publicKey: PublicKey; account: unknown }) => tokenStateToToken(a.account, a.account && typeof a.account === 'object' && 'mint' in a.account ? (a.account as { mint: PublicKey }).mint.toBase58() : a.publicKey.toBase58()));
        const withImages = await enrichTokensWithMetadata(mine);
        if (!cancelled) setOnChainTokens(withImages);
      } catch {
        // Chain fetch failed — will fall back to mock
      }
    }
    fetchMyTokens();
    return () => { cancelled = true; };
  }, [publicKey, connection]);

  const myTokens = onChainTokens ?? MOCK_TOKENS.filter(t => t.phase === "graduated" || t.solRaised > 10);

  const totalClaimable = myTokens
    .filter(t => t.phase === "graduated")
    .reduce((sum, t) => sum + (t.creatorFeesEarned ?? 0), 0);

  const handleClaim = async (mintAddress: string, tokenName: string) => {
    if (!program) {
      toast.error("Connect your wallet to claim");
      return;
    }
    setClaiming(mintAddress);
    try {
      const mint = new PublicKey(mintAddress);
      console.log("[higher.run] claimCreatorFees for mint:", mintAddress);
      const tx = await program.methods
        .claimCreatorFees()
        .accountsPartial({ mint })
        .rpc();
      console.log("[higher.run] claimCreatorFees TX confirmed:", tx);
      toast.success(`Claimed royalties from ${tokenName}! TX: ${tx.slice(0, 8)}...`);
    } catch (error) {
      console.error("[higher.run] Claim failed:", error);
      const msg = error instanceof Error ? error.message : "Claim failed";
      toast.error(msg.length > 120 ? msg.slice(0, 120) + "..." : msg);
    } finally {
      setClaiming(null);
    }
  };

  const copyLink = () => {
    navigator.clipboard.writeText(`https://higher.run/${publicKey?.toBase58().slice(0, 8)}`);
    toast.success("Profile link copied");
  };

  if (!connected) {
    return (
      <div className="max-w-sm mx-auto px-6 py-20 text-center">
        <div className="w-12 h-12 rounded-full flex items-center justify-center mx-auto mb-4" style={{ background: "rgba(175,145,90,0.12)", color: "#8a7050" }}>
          <BadgeDollarSign size={24} />
        </div>
        <h1 className="text-xl font-bold text-gray-900 mb-1">Dashboard</h1>
        <p className="text-sm text-gray-500 mb-6">Connect your wallet to view your tokens and earnings.</p>
        <WalletMultiButton />
      </div>
    );
  }

  const filteredTokens = tab === "all" ? myTokens
    : tab === "graduated" ? myTokens.filter(t => t.phase === "graduated")
    : myTokens.filter(t => t.phase === "bonding");

  return (
    <div className="max-w-3xl mx-auto px-6 py-8">
      {/* Profile card */}
      <div className="bg-white rounded-2xl p-6 mb-6">
        <div className="flex items-start justify-between mb-4">
          <div>
            <p className="text-gray-400 text-xs uppercase tracking-wider mb-1">Balance</p>
            <p className="text-3xl font-bold text-gray-900">{totalClaimable.toFixed(4)} SOL</p>
            <p className="text-gray-400 text-sm">~{formatUSD(totalClaimable * 140)}</p>
          </div>
          <div className="w-10 h-10 rounded-full flex items-center justify-center text-sm font-bold" style={{ background: "rgba(175,145,90,0.14)", color: "#8a7050" }}>
            {publicKey?.toBase58().slice(0, 2).toUpperCase()}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-sm text-gray-500">{publicKey ? shortenAddress(publicKey.toBase58(), 6) : ""}</span>
        </div>
      </div>

      {/* Action buttons */}
      <div className="grid grid-cols-2 gap-3 mb-6">
        <Link
          href="/create"
          className="flex items-center justify-center gap-2 py-3 rounded-xl font-semibold text-sm transition-colors"
          style={{ background: "linear-gradient(-75deg, rgba(255,255,255,0.9), rgba(175,145,90,0.12), rgba(255,255,255,0.85))", boxShadow: "0 1px 4px rgba(0,0,0,0.06), inset 0 0 0 1px rgba(175,145,90,0.18)", color: "#8a7050" }}
        >
          <Zap size={15} /> New Project
        </Link>
        <button
          onClick={copyLink}
          className="flex items-center justify-center gap-2 bg-white text-gray-600 py-3 rounded-xl font-medium text-sm hover:bg-gray-50 transition-colors"
          style={{ boxShadow: "0 1px 4px rgba(0,0,0,0.06), inset 0 0 0 1px rgba(0,0,0,0.06)" }}
        >
          <Share2 size={15} /> Share Profile
        </button>
      </div>

      {/* Profile link */}
      <div className="flex items-center gap-3 bg-white rounded-xl px-4 py-3 mb-6">
        <span className="text-xs text-gray-400">🔗</span>
        <span className="text-sm text-gray-600 flex-1 truncate font-mono">
          higher.run/{publicKey?.toBase58().slice(0, 8)}
        </span>
        <button onClick={copyLink} className="text-gray-400 hover:text-gray-600 transition-colors">
          <Copy size={14} />
        </button>
        <button
          onClick={copyLink}
          className="px-3 py-1 rounded-lg text-xs font-semibold transition-colors"
          style={{ background: "rgba(175,145,90,0.12)", boxShadow: "inset 0 0 0 1px rgba(175,145,90,0.18)", color: "#8a7050" }}
        >
          share
        </button>
      </div>

      {/* Earnings card */}
      <div className="bg-white rounded-xl px-4 py-3 mb-6">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-[10px] text-gray-400 uppercase tracking-wider">Earnings</p>
            <p className="text-xl font-bold text-gray-900">{formatUSD(totalClaimable * 140 * 3.2)}</p>
          </div>
          {totalClaimable > 0 && (
            <button
              className="px-4 py-2 rounded-xl text-xs font-semibold transition-colors"
              style={{ background: "linear-gradient(-75deg, rgba(255,255,255,0.9), rgba(175,145,90,0.12), rgba(255,255,255,0.85))", boxShadow: "0 1px 4px rgba(0,0,0,0.06), inset 0 0 0 1px rgba(175,145,90,0.18)", color: "#8a7050" }}
            >
              Claim All
            </button>
          )}
        </div>
      </div>

      {/* Tabs — Bags.fm style */}
      <div className="flex items-center gap-1 border-b border-gray-100 mb-4">
        {(
          [
            { key: "all", label: "All Coins" },
            { key: "graduated", label: "Graduated" },
            { key: "active", label: "Active" },
          ] as { key: typeof tab; label: string }[]
        ).map(({ key, label }) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={cn(
              "px-4 py-2.5 text-sm font-medium transition-colors border-b-2 -mb-px",
              tab === key
                ? "text-gray-900 border-gray-900"
                : "text-gray-400 border-transparent hover:text-gray-600"
            )}
          >
            {label}
          </button>
        ))}
      </div>

      {/* Token list */}
      {filteredTokens.length === 0 ? (
        <div className="text-center py-16">
          <p className="text-sm text-gray-400">No launches found</p>
        </div>
      ) : (
        <div className="space-y-3">
          {filteredTokens.map(token => {
            const progress = calcBondingCurveProgress(token.solRaised, token.targetSOL);
            const grad = token.phase === "graduated";

            return (
              <div key={token.id} className="bg-white rounded-2xl p-4">
                <div className="flex items-center gap-3">
                  <div className="relative w-10 h-10 rounded-xl overflow-hidden flex-shrink-0 bg-gray-100">
                    <Image src={token.imageUrl} alt={token.name} fill className="object-cover" unoptimized />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5">
                      <span className="font-semibold text-sm text-gray-900">{token.name}</span>
                      <span className="text-xs text-gray-400">${token.ticker}</span>
                      {grad && <span className="w-1.5 h-1.5 rounded-full" style={{ background: "rgba(175,145,90,0.6)" }} />}
                    </div>
                    <p className="text-xs text-gray-400 truncate">
                      {grad
                        ? `${token.creatorFeesEarned?.toFixed(4)} SOL earned`
                        : `${progress.toFixed(0)}% · ${(token.targetSOL - token.solRaised).toFixed(1)} SOL to go`}
                    </p>
                  </div>

                  <div className="text-right mr-2">
                    <p className="text-sm font-semibold text-gray-900">{formatUSD(token.marketCap)}</p>
                    {!grad && (
                      <div className="w-16 h-1 bg-gray-100 rounded-full overflow-hidden mt-1">
                        <div className="h-full rounded-full" style={{ width: `${progress}%`, background: "rgba(175,145,90,0.45)" }} />
                      </div>
                    )}
                  </div>

                  <div className="flex gap-1.5">
                    {grad && (
                      <button
                        onClick={() => handleClaim(token.mint, token.name)}
                        disabled={claiming === token.mint}
                        className="px-3 py-1.5 rounded-lg text-xs font-semibold disabled:opacity-40 transition-all"
                        style={{ background: "linear-gradient(-75deg, rgba(255,255,255,0.9), rgba(175,145,90,0.12), rgba(255,255,255,0.85))", boxShadow: "0 1px 4px rgba(0,0,0,0.06), inset 0 0 0 1px rgba(175,145,90,0.18)", color: "#8a7050" }}
                      >
                        {claiming === token.mint ? "..." : "Claim"}
                      </button>
                    )}
                    <Link
                      href={`/token/${token.mint}`}
                      className="border border-gray-200 text-gray-400 hover:text-gray-600 px-2 py-1.5 rounded-lg transition-colors"
                    >
                      <ExternalLink size={12} />
                    </Link>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
