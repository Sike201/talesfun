"use client";

import { use, useState, useEffect } from "react";
import Image from "next/image";
import Link from "next/link";
import { useConnection } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import { MOCK_TOKENS, MOCK_TRADES } from "@/lib/mockData";
import {
  formatUSD, formatNumber, shortenAddress, timeAgo, calcBondingCurveProgress
} from "@/lib/utils";
import { getReadOnlyProgram, getTokenStatePDA, tokenStateToToken } from "@/lib/program";
import { enrichTokenWithFetchedMetadata } from "@/lib/metadata";
import TradePanel from "@/components/ui/TradePanel";
import TradingInterface from "@/components/ui/TradingInterface";
import { Token, Trade } from "@/types";

type TradeHistoryRow = {
  id?: string;
  mint: string;
  signature: string;
  side: string;
  wallet?: string | null;
  sol_amount_raw?: string | null;
  token_amount_raw?: string | null;
  price_sol?: number | null;
  timestamp: string;
};

function mapTradeHistoryRow(row: TradeHistoryRow): Trade {
  const solRaw = Number(row.sol_amount_raw ?? 0);
  const tokenRaw = Number(row.token_amount_raw ?? 0);
  const priceSol =
    typeof row.price_sol === "number" && Number.isFinite(row.price_sol)
      ? row.price_sol
      : Number(row.price_sol);
  return {
    id: typeof row.id === "string" && row.id ? row.id : row.signature,
    tokenMint: row.mint,
    trader: row.wallet ?? "",
    type: row.side === "sell" ? "sell" : "buy",
    solAmount: Number.isFinite(solRaw) ? solRaw / 1e9 : 0,
    tokenAmount: Number.isFinite(tokenRaw) ? tokenRaw / 1e6 : 0,
    price: Number.isFinite(priceSol) ? priceSol : 0,
    timestamp: new Date(row.timestamp),
    txSignature: row.signature,
  };
}
import {
  ExternalLink, Copy, CheckCircle2, ArrowUpRight
} from "lucide-react";
import toast from "react-hot-toast";
import { cn } from "@/lib/utils";

export default function TokenPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { connection } = useConnection();
  const [token, setToken] = useState<Token | null>(null);
  const [trades, setTrades] = useState<Trade[]>([]);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      // Try on-chain fetch if id looks like a Solana pubkey
      try {
        const mint = new PublicKey(id);
        const program = getReadOnlyProgram(connection);
        const [pda] = getTokenStatePDA(mint);
        const state = await (program.account as any).tokenState.fetch(pda);
        let next = tokenStateToToken(state, id);
        if (!cancelled) {
          try {
            next = await enrichTokenWithFetchedMetadata(next);
          } catch (e) {
            console.warn("[token] metadata fetch failed:", e);
          }
        }
        if (!cancelled) {
          setToken(next);
        }
        return;
      } catch {
        // Not a valid pubkey or account doesn't exist — fall back to mock
      }
      if (!cancelled) {
        const mock = MOCK_TOKENS.find(t => t.id === id || t.mint === id) ?? MOCK_TOKENS[0];
        setToken(mock);
        setTrades(MOCK_TRADES.filter(t => t.tokenMint === mock.mint));
      }
    }
    load();
    return () => { cancelled = true; };
  }, [id, connection]);

  useEffect(() => {
    const mint = token?.mint;
    if (!mint) return;
    let cancelled = false;

    const fetchTrades = async () => {
      console.log("[higher.run] trade history: querying mint", mint);
      try {
        const res = await fetch(
          `/api/tokens/${encodeURIComponent(mint)}/trades?limit=50`
        );
        const data = await res.json();
        if (cancelled) return;
        if (!res.ok || (data && typeof data === "object" && "error" in data)) {
          console.warn("[higher.run] trade history: fetch failed", data);
          setTrades([]);
          return;
        }
        const rows = Array.isArray(data) ? (data as TradeHistoryRow[]) : [];
        console.log("[higher.run] trade history: row count", rows.length);
        if (rows.length > 0) {
          const r = rows[0];
          console.log("[higher.run] trade history: first row preview", {
            mint: r.mint,
            side: r.side,
            wallet: r.wallet ? `${String(r.wallet).slice(0, 4)}…` : null,
            signature: r.signature ? `${r.signature.slice(0, 8)}…` : null,
            timestamp: r.timestamp,
          });
        }
        setTrades(rows.map(mapTradeHistoryRow));
      } catch (e) {
        if (!cancelled) {
          console.warn("[higher.run] trade history: error", e);
          setTrades([]);
        }
      }
    };

    void fetchTrades();

    const onTradeComplete = (e: Event) => {
      const detail = (e as CustomEvent<{ mint?: string }>).detail;
      if (detail?.mint === mint) void fetchTrades();
    };
    window.addEventListener("higher:trade-complete", onTradeComplete);
    return () => {
      cancelled = true;
      window.removeEventListener("higher:trade-complete", onTradeComplete);
    };
  }, [token?.mint]);

  if (!token) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <p className="text-sm text-gray-400 animate-pulse">Loading token...</p>
      </div>
    );
  }

  const progress = calcBondingCurveProgress(token.solRaised, token.targetSOL);
  const graduated = token.phase === "graduated";
  const priceUSD = token.currentPrice * 140;
  const impliedFDV = formatUSD(token.currentPrice * token.totalSupply * 140);
  const raiseGoal = formatUSD(token.targetSOL * 140);
  const totalLiq = (token.solRaised * 140) + token.marketCap * 0.2;

  const copyMint = () => {
    navigator.clipboard.writeText(token.mint);
    setCopied(true);
    toast.success("Copied");
    setTimeout(() => setCopied(false), 2000);
  };

  if (!graduated) {
    return <BondingPhasePage token={token} trades={trades} progress={progress} impliedFDV={impliedFDV} raiseGoal={raiseGoal} copied={copied} copyMint={copyMint} />;
  }

  return (
    <div className="min-h-screen px-4 sm:px-6 py-6">
      <div className="max-w-7xl mx-auto">

        {/* ── Token header bar ── */}
        <div className="bg-white rounded-lg p-4 mb-4">
          <div className="flex items-center gap-4 flex-wrap">
            {/* Token identity */}
            <div className="relative w-10 h-10 rounded-lg overflow-hidden flex-shrink-0 bg-gray-100">
              <Image src={token.imageUrl} alt={token.name} fill className="object-cover" unoptimized />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="font-bold text-gray-900">{token.ticker}</span>
                <span className="text-sm text-gray-400">{token.name}</span>
              </div>
              <div className="flex items-center gap-3 mt-0.5 text-xs text-gray-400">
                {token.twitter && (
                  <a href={`https://twitter.com/${token.twitter}`} target="_blank" rel="noopener noreferrer" className="hover:text-gray-600 transition-colors">
                    Twitter
                  </a>
                )}
                {token.website && (
                  <a href={token.website} target="_blank" rel="noopener noreferrer" className="hover:text-gray-600 transition-colors">
                    Website
                  </a>
                )}
                {token.telegram && (
                  <a href={`https://t.me/${token.telegram}`} target="_blank" rel="noopener noreferrer" className="hover:text-gray-600 transition-colors">
                    Telegram
                  </a>
                )}
              </div>
            </div>

            {/* Price & stats */}
            <div className="ml-auto flex items-center gap-6 text-sm flex-wrap">
              <div>
                <span className="text-xs text-gray-400 block">Market cap</span>
                <span className="font-bold text-gray-900 text-lg">{formatUSD(token.marketCap)}</span>
              </div>
              <div className="hidden sm:flex items-center gap-4 text-xs text-gray-400">
                <span>Price <span className="text-gray-700 font-medium">${priceUSD.toFixed(6)}</span></span>
                <span>Liq <span className="text-gray-700 font-medium">{formatUSD(totalLiq)}</span></span>
                <span>Volume <span className="text-gray-700 font-medium">{formatUSD(token.volume24h ?? 0)}</span></span>
                <span>Holders <span className="text-gray-700 font-medium">{formatNumber(token.funders * 100)}</span></span>
              </div>
            </div>
          </div>
        </div>

        {/* ── Main layout: chart+table left, trade+stats right ── */}
        <div className="grid lg:grid-cols-[1fr_340px] gap-4 items-start lg:items-stretch">

          {/* Left column — flex col so About stretches to match right side */}
          <div className="flex flex-col gap-4">
            {/* Chart placeholder */}
            <div className="bg-white rounded-lg overflow-hidden flex-shrink-0">
              <div className="h-[400px] bg-gray-950 flex items-center justify-center relative">
                <div className="text-center">
                  <p className="text-white/30 text-sm font-medium">TradingView Chart</p>
                  <p className="text-white/15 text-xs mt-1">Connect to live data</p>
                </div>
                <div className="absolute bottom-3 left-3 flex gap-1 flex-wrap">
                  {["1s", "5s", "15s", "30s", "1m", "5m", "15m", "30m", "1h", "4h", "8h", "24h", "1w"].map(t => (
                    <span key={t} className={cn(
                      "text-[9px] px-1.5 py-0.5 rounded cursor-pointer",
                      t === "1h" ? "bg-white/10 text-white/60" : "text-white/20 hover:text-white/40"
                    )}>{t}</span>
                  ))}
                </div>
              </div>
            </div>

            {/* Trade history — scrollable, taller */}
            <div className="bg-white rounded-lg overflow-hidden flex-shrink-0">
              <div className="grid grid-cols-8 gap-2 px-4 py-2.5 text-[10px] text-gray-400 uppercase tracking-wider border-b border-gray-100 font-semibold sticky top-0 bg-white z-10">
                <span>Time</span>
                <span>Type</span>
                <span>USD</span>
                <span>{token.ticker}</span>
                <span>SOL</span>
                <span>MCap</span>
                <span>Trader</span>
                <span className="text-right">TX</span>
              </div>
              <div className="max-h-[340px] overflow-y-auto scrollbar-hide [&::-webkit-scrollbar]:hidden">
                {trades.length > 0 ? (
                  trades.map(trade => (
                    <div key={trade.id} className="grid grid-cols-8 gap-2 px-4 py-2.5 text-xs border-b border-gray-50 last:border-0 hover:bg-gray-50 transition-colors">
                      <span className="text-gray-400">{timeAgo(trade.timestamp)}</span>
                      <span className={cn("font-semibold", trade.type === "buy" ? "text-green-500" : "text-red-500")}>
                        {trade.type}
                      </span>
                      <span className="text-gray-700">${(trade.price * 140).toFixed(2)}</span>
                      <span className="text-gray-600">{formatNumber(trade.tokenAmount)}</span>
                      <span className="text-gray-600">{trade.solAmount.toFixed(3)}</span>
                      <span className="text-gray-600">{formatUSD(token.marketCap)}</span>
                      <span className="text-gray-400 truncate">{trade.trader}</span>
                      <span className="text-right">
                        <a href={`https://solscan.io/tx/${trade.txSignature}`} target="_blank" rel="noopener noreferrer" className="text-gray-300 hover:text-gray-500">
                          <ArrowUpRight size={11} />
                        </a>
                      </span>
                    </div>
                  ))
                ) : (
                  <div className="px-4 py-12 text-center text-sm text-gray-300">No trades yet</div>
                )}
              </div>
            </div>

            {/* About — flex-1 fills remaining height to match right column */}
            <div className="bg-white rounded-lg p-5 flex-1">
              <div className="flex items-center gap-3 mb-3">
                <h2 className="text-sm font-bold text-gray-900">About</h2>
                {token.twitter && (
                  <a href={`https://twitter.com/${token.twitter}`} target="_blank" rel="noopener noreferrer"
                    className="text-[11px] text-gray-400 hover:text-gray-700 transition-colors flex items-center gap-1">
                    <ExternalLink size={10} /> Twitter
                  </a>
                )}
                {token.website && (
                  <a href={token.website} target="_blank" rel="noopener noreferrer"
                    className="text-[11px] text-gray-400 hover:text-gray-700 transition-colors flex items-center gap-1">
                    <ExternalLink size={10} /> Website
                  </a>
                )}
                {token.telegram && (
                  <a href={`https://t.me/${token.telegram}`} target="_blank" rel="noopener noreferrer"
                    className="text-[11px] text-gray-400 hover:text-gray-700 transition-colors flex items-center gap-1">
                    <ExternalLink size={10} /> Telegram
                  </a>
                )}
              </div>
              <p className="text-sm text-gray-600 leading-relaxed whitespace-pre-line">
                {token.about || token.description}
              </p>
            </div>
          </div>

          {/* Right column */}
          <div className="flex flex-col gap-4">
            {/* Trade panel */}
            <TradingInterface token={token} />

            {/* GAMM Pool Statistics */}
            <div className="bg-white rounded-lg p-4">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-sm font-bold text-gray-900">${token.ticker} GAMM Pool</h3>
                <a
                  href="https://www.omnipair.fi/markets"
                  target="_blank"
                  rel="noopener noreferrer"
                  title="View on Omnipair"
                  className="text-gray-400 hover:text-gray-700 transition-colors"
                >
                  <ArrowUpRight size={14} />
                </a>
              </div>

              {/* Top stats */}
              <div className="grid grid-cols-2 gap-4 mb-4">
                <div>
                  <p className="text-xs text-gray-400">Total Liquidity</p>
                  <p className="text-lg font-bold text-gray-900">{formatUSD(totalLiq)}</p>
                </div>
                <div>
                  <p className="text-xs text-gray-400">Utilization</p>
                  <p className="text-lg font-bold text-gray-900">62.4%</p>
                </div>
                <div>
                  <p className="text-xs text-gray-400">Total APY</p>
                  <p className="text-lg font-bold text-gray-900">14.2%</p>
                </div>
                <div>
                  <p className="text-xs text-gray-400">Total Debt</p>
                  <p className="text-lg font-bold text-gray-900">{formatUSD(totalLiq * 0.624 * 0.3)}</p>
                </div>
              </div>

              {/* Simplified fee / earnings */}
              <div className="space-y-2 text-xs border-t border-gray-100 pt-3">
                <div className="flex justify-between">
                  <span className="text-gray-400">Creator Earned (All Time)</span>
                  <span className="font-semibold text-gray-700">{token.creatorFeesEarned?.toFixed(4)} SOL</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-400">24h Fees</span>
                  <span className="text-gray-700 font-medium">{formatUSD((token.volume24h ?? 0) * 0.01)}</span>
                </div>
              </div>
            </div>

            {/* Holder Distribution (mock) */}
            <div className="bg-white rounded-lg p-4">
              <h3 className="text-sm font-bold text-gray-900 mb-3">Holder Distribution</h3>
              <div className="space-y-2 text-xs">
                {[
                  { addr: "FD7Y...", pct: "25.468%" },
                  { addr: "KpXr...", pct: "20.078%" },
                  { addr: "6eeY...", pct: "13.035%" },
                  { addr: "D3ki...", pct: "13.033%" },
                  { addr: "HDhl...", pct: "6.972%" },
                  { addr: "7kw5...", pct: "6.329%" },
                ].map((h, i) => (
                  <div key={h.addr} className="flex items-center justify-between">
                    <span className="text-gray-400">{i + 1}. {h.addr}</span>
                    <span className="text-gray-700 font-medium">{h.pct}</span>
                  </div>
                ))}
              </div>
            </div>

            {/* Contract */}
            <div className="bg-white rounded-lg p-4">
              <h3 className="text-[10px] text-gray-400 uppercase tracking-wider font-semibold mb-2">Contract</h3>
              <div className="flex items-center gap-2">
                <code className="text-xs text-gray-500 font-mono flex-1 truncate">{token.mint}</code>
                <button onClick={copyMint} className="text-gray-400 hover:text-gray-600 transition-colors flex-shrink-0">
                  {copied ? <CheckCircle2 size={13} className="text-green-500" /> : <Copy size={13} />}
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ─── Bonding Phase (non-graduated) ─────────────────────────────────── */

function BondingPhasePage({
  token, trades, progress, impliedFDV, raiseGoal, copied, copyMint,
}: {
  token: any; trades: any[]; progress: number; impliedFDV: string; raiseGoal: string; copied: boolean; copyMint: () => void;
}) {
  return (
    <div className="min-h-screen px-6 py-8">
      <div className="max-w-6xl mx-auto">
        <div className="flex items-center gap-2 text-xs text-gray-400 mb-6">
          <Link href="/launches" className="hover:text-green-500 transition-colors">Explore</Link>
          <span>/</span>
          <span className="text-gray-600">{token.name}</span>
        </div>

        <div className="flex items-center gap-4 mb-6">
          <div className="relative w-12 h-12 rounded-lg overflow-hidden flex-shrink-0 bg-gray-100">
            <Image src={token.imageUrl} alt={token.name} fill className="object-cover" unoptimized />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h1 className="text-lg font-bold text-gray-900">{token.name}</h1>
              <span className="text-sm text-gray-400">${token.ticker}</span>
              <span className="bg-yellow-100 text-yellow-700 text-[10px] font-semibold px-2 py-0.5 rounded-full uppercase">Live</span>
            </div>
          </div>
        </div>

        <div className="mb-6">
          <div className="flex items-center justify-between text-xs mb-1.5">
            <span className="text-green-600 font-semibold">{formatUSD(token.solRaised * 140)}</span>
            <span className="text-gray-400">{progress.toFixed(0)}%</span>
            <span className="text-gray-400">{raiseGoal} <span className="text-gray-300">goal</span></span>
          </div>
          <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
            <div className="h-full bg-green-500 rounded-full transition-all" style={{ width: `${progress}%` }} />
          </div>
        </div>

        <div className="grid lg:grid-cols-3 gap-6">
          <div className="lg:col-span-2 space-y-5">
            <div className="bg-white rounded-lg p-6">
              <h2 className="text-sm font-bold text-gray-900 mb-4">About</h2>
              <div className="text-sm text-gray-600 leading-relaxed whitespace-pre-line">
                {token.about || token.description}
              </div>
            </div>
            <div className="bg-white rounded-lg overflow-hidden">
              <div className="px-6 py-4 border-b border-gray-100">
                <h2 className="text-sm font-bold text-gray-900">Trade History</h2>
              </div>
              {trades.length > 0 ? trades.map((trade: any) => (
                <div key={trade.id} className="flex items-center gap-4 px-6 py-3 text-xs border-b border-gray-50 last:border-0 hover:bg-gray-50">
                  <span className={cn("font-semibold w-8", trade.type === "buy" ? "text-green-500" : "text-red-500")}>{trade.type}</span>
                  <span className="text-gray-600 flex-1">{formatNumber(trade.tokenAmount)} {token.ticker}</span>
                  <span className="text-gray-600">{trade.solAmount.toFixed(2)} SOL</span>
                  <span className="text-gray-400">{timeAgo(trade.timestamp)}</span>
                </div>
              )) : (
                <div className="px-6 py-10 text-center text-sm text-gray-300">No trades yet</div>
              )}
            </div>
          </div>

          <div className="space-y-4">
            <div className="bg-white rounded-lg overflow-hidden">
              <TradePanel token={token} />
            </div>
            <div className="bg-white rounded-lg p-5">
              <h3 className="text-[10px] text-gray-400 uppercase tracking-wider font-semibold mb-3">Details</h3>
              <div className="space-y-2 text-xs">
                <div className="flex justify-between"><span className="text-gray-400">Implied FDV</span><span className="font-bold text-gray-900">{impliedFDV}</span></div>
                <div className="flex justify-between"><span className="text-gray-400">Launch Price</span><span className="text-gray-600">${(token.launchPrice * 140).toFixed(4)}</span></div>
                <div className="flex justify-between"><span className="text-gray-400">Raise Goal</span><span className="text-gray-600">{raiseGoal}</span></div>
                <div className="flex justify-between"><span className="text-gray-400">Supply</span><span className="text-gray-600">{formatNumber(token.totalSupply)}</span></div>
              </div>
            </div>
            <div className="bg-white rounded-lg p-5">
              <h3 className="text-[10px] text-gray-400 uppercase tracking-wider font-semibold mb-2">Contract</h3>
              <div className="flex items-center gap-2">
                <code className="text-xs text-gray-500 font-mono flex-1 truncate">{token.mint}</code>
                <button onClick={copyMint} className="text-gray-400 hover:text-gray-600 transition-colors">
                  {copied ? <CheckCircle2 size={13} className="text-green-500" /> : <Copy size={13} />}
                </button>
                <a href={`https://explorer.solana.com/address/${token.mint}?cluster=devnet`} target="_blank" rel="noopener noreferrer" className="text-gray-400 hover:text-gray-600 transition-colors">
                  <ExternalLink size={13} />
                </a>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
