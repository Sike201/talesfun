"use client";

import { use, useState, useEffect, useMemo, useRef } from "react";
import { useSearchParams } from "next/navigation";
import Image from "next/image";
import Link from "next/link";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import { MOCK_TOKENS } from "@/lib/mockData";
import {
  formatUSD, formatNumber, shortenAddress, timeAgo, calcBondingCurveProgress,
  formatSolPerTokenPrice,
} from "@/lib/utils";
import {
  applyTokenMarketCapUsd,
  getReadOnlyProgram,
  getTokenStatePDA,
  tokenStateToToken,
  hasRealOmnipairPoolOnChain,
  OMNIPAIR_PROGRAM_ID_STR,
} from "@/lib/program";
import { sendBootstrapOmnipairPoolTx } from "@/lib/omnipairBootstrap";
import type { AnchorWallet } from "@solana/wallet-adapter-react";
import {
  enrichTokenWithFetchedMetadata,
  mergeTokenMetadataFromSupabaseRow,
  needsRemoteMetadataFetch,
  type SupabaseTokenRow,
} from "@/lib/metadata";
import { useSolUsd } from "@/hooks/useSolUsd";
import { useWalletBalances } from "@/hooks/useWalletBalances";
import { useMintHolderCount } from "@/hooks/useMintHolderCount";
import { useOmnipairPoolState } from "@/hooks/useOmnipairPoolState";
import { lamportsStrToSol, volume24hUsdFormatted } from "@/lib/volume24h";
import { requestTokenPhaseSync } from "@/lib/requestTokenPhaseSync";
import TradePanel from "@/components/ui/TradePanel";
import TokenCandlestickChart from "@/components/ui/TokenCandlestickChart";
import TradingInterface from "@/components/ui/TradingInterface";
import OmnipairPoolCard from "@/components/ui/OmnipairPoolCard";
import { Token, Trade } from "@/types";
import {
  ExternalLink, Copy, CheckCircle2, ArrowUpRight
} from "lucide-react";
import toast from "react-hot-toast";
import { cn } from "@/lib/utils";
import { logTokenStateChainVsSupabase } from "@/lib/debugChainVsSupabase";
import { logBondingPanelDebug } from "@/lib/bondingCurveQuote";

/** Row shape from Supabase / GET /api/tokens/[mint]/trades */
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
  source?: string | null;
};

function mapTradeHistoryRow(row: TradeHistoryRow): Trade {
  const solRaw = Number(row.sol_amount_raw ?? 0);
  const tokenRaw = Number(row.token_amount_raw ?? 0);
  const priceSol =
    typeof row.price_sol === "number" && Number.isFinite(row.price_sol)
      ? row.price_sol
      : Number(row.price_sol);
  const src =
    row.source === "omnipair"
      ? "omnipair"
      : row.source === "bonding"
        ? "bonding"
        : undefined;
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
    ...(src ? { source: src } : {}),
  };
}

/** Prefer on-chain `tokenState.mint` so reads match POST /api/trades (canonical base58). */
function canonicalMintFromTokenState(state: unknown, fallback: string): string {
  const s = state as { mint?: { toBase58?: () => string } };
  if (s?.mint && typeof s.mint.toBase58 === "function") {
    return s.mint.toBase58();
  }
  return fallback;
}

function TokenWalletBalancesRow({ mint, ticker }: { mint: string; ticker: string }) {
  const { connected } = useWallet();
  const { solBalanceDisplay, tokenBalanceDisplay, loading } = useWalletBalances(mint);
  if (!connected) return null;
  return (
    <div className="flex flex-wrap gap-8 mb-4 text-sm bg-white rounded-lg px-4 py-3 border border-gray-100">
      <div>
        <span className="text-[10px] text-gray-400 uppercase tracking-wider font-semibold block mb-0.5">
          Wallet SOL
        </span>
        <span className="font-semibold text-gray-900 tabular-nums">
          {loading ? "…" : `${solBalanceDisplay} SOL`}
        </span>
      </div>
      <div>
        <span className="text-[10px] text-gray-400 uppercase tracking-wider font-semibold block mb-0.5">
          Wallet {ticker}
        </span>
        <span className="font-semibold text-gray-900 tabular-nums">
          {loading ? "…" : tokenBalanceDisplay}
        </span>
      </div>
    </div>
  );
}

export default function TokenPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const searchParams = useSearchParams();
  const leverageParam = searchParams.get("leverage");
  const tradingInitialMode =
    leverageParam === "long" || leverageParam === "short" ? ("leverage" as const) : undefined;
  const tradingLeverageDir =
    leverageParam === "long" || leverageParam === "short" ? leverageParam : undefined;
  const { connection } = useConnection();
  const walletAdapter = useWallet();
  const connectedWallet = walletAdapter.publicKey;
  const { solUsd } = useSolUsd();
  /** Latest SOL/USD for post-trade token merge without re-subscribing trade-history on every tick. */
  const solUsdRef = useRef(solUsd);
  solUsdRef.current = solUsd;
  /** For debug logs only — do not put `connectedWallet` in trade-history effect deps (wallet switches must not reset listener). */
  const walletLogRef = useRef<string | null>(null);
  walletLogRef.current = connectedWallet?.toBase58() ?? null;
  const [token, setToken] = useState<Token | null>(null);
  const [trades, setTrades] = useState<Trade[]>([]);
  /** Summed lamports in last 24h for this mint (from Supabase). */
  const [volume24hLamportsStr, setVolume24hLamportsStr] = useState("0");
  const [postTradeSyncing, setPostTradeSyncing] = useState(false);
  const [copied, setCopied] = useState(false);
  const [metadataPending, setMetadataPending] = useState(false);
  const { count: holderCount, loading: holderLoading } = useMintHolderCount(token?.mint);
  const [omnipairBootstrapBusy, setOmnipairBootstrapBusy] = useState(false);

  const omnipairPoolLiveForHook = useMemo(
    () => (token ? hasRealOmnipairPoolOnChain(token) : false),
    [token]
  );
  const {
    snapshot: omnipairSnapshot,
    loading: omnipairPoolLoading,
    error: omnipairPoolError,
  } = useOmnipairPoolState({
    pairAddress: token?.gammPool,
    projectMint: token?.mint,
    enabled: token?.phase === "graduated" && omnipairPoolLiveForHook,
  });

  const validMintPk = useMemo(() => {
    try {
      return new PublicKey(id);
    } catch {
      return null;
    }
  }, [id]);

  useEffect(() => {
    let cancelled = false;
    const perfStart = performance.now();
    const timings: { name: string; ms: number }[] = [];

    async function timed<T>(name: string, p: Promise<T>): Promise<T> {
      const t0 = performance.now();
      const v = await p;
      timings.push({ name, ms: performance.now() - t0 });
      return v;
    }

    async function load() {
      setMetadataPending(false);
      try {
        const mint = new PublicKey(id);
        const mintFromUrl = mint.toBase58();
        const program = getReadOnlyProgram(connection);
        const [pda] = getTokenStatePDA(mint);

        const stateRes = await timed(
          "chain_tokenState",
          (program.account as any).tokenState.fetch(pda)
        );

        const canonicalMint = canonicalMintFromTokenState(stateRes, mintFromUrl);
        if (canonicalMint !== mintFromUrl) {
          console.warn(
            "[trade-history] route id mint !== on-chain tokenState.mint (using on-chain for reads)",
            mintFromUrl,
            canonicalMint
          );
        }

        const [sbRes, tradesRes, volRes, solUsdJson] = await Promise.all([
          timed(
            "supabase_token_row",
            fetch(`/api/tokens/${encodeURIComponent(canonicalMint)}`).then(
              async r => {
                const j = await r.json();
                if (!r.ok) return null;
                if (
                  j &&
                  typeof j === "object" &&
                  "error" in j &&
                  !("mint" in j)
                ) {
                  return null;
                }
                return j as SupabaseTokenRow;
              }
            )
          ),
          timed(
            "supabase_trades",
            fetch(
              `/api/tokens/${encodeURIComponent(canonicalMint)}/trades?limit=5000`
            ).then(async r => {
              const j = await r.json();
              return { ok: r.ok, status: r.status, body: j };
            })
          ),
          timed(
            "volume_24h",
            fetch(
              `/api/trades/volume-24h?mint=${encodeURIComponent(canonicalMint)}`
            ).then(r => r.json())
          ),
          timed("sol_usd", fetch("/api/sol-usd").then(r => r.json())),
        ]);

        if (cancelled) return;

        let su: number | undefined;
        if (
          typeof solUsdJson.solUsd === "number" &&
          solUsdJson.solUsd > 0
        ) {
          su = solUsdJson.solUsd;
        }

        let next = tokenStateToToken(stateRes, canonicalMint, { solUsd: su });
        const sbRow =
          sbRes &&
          typeof sbRes === "object" &&
          "mint" in sbRes &&
          typeof (sbRes as { mint: unknown }).mint === "string"
            ? (sbRes as SupabaseTokenRow)
            : null;
        logTokenStateChainVsSupabase(
          canonicalMint.slice(0, 8) + "…",
          next,
          sbRow != null ? (sbRes as Record<string, unknown>) : null
        );
        next = mergeTokenMetadataFromSupabaseRow(next, sbRow);
        next = applyTokenMarketCapUsd(next, su);
        if (sbRow?.image_url || sbRow?.description || sbRow?.about) {
          console.log(
            "[metadata] token page: image/about from Supabase",
            canonicalMint.slice(0, 8) + "…"
          );
        }

        const trWrap = tradesRes as {
          ok: boolean;
          status: number;
          body: unknown;
        };
        const walletAtQuery = walletLogRef.current;
        if (trWrap.ok && Array.isArray(trWrap.body)) {
          const trData = trWrap.body as TradeHistoryRow[];
          console.log("[trade-history] initial load OK", {
            mintQueried: canonicalMint,
            walletAtQuery,
            rowCount: trData.length,
          });
          setTrades(trData.map(mapTradeHistoryRow));
        } else {
          console.warn(
            "[trade-history] initial load failed (trades not replaced)",
            {
              mintQueried: canonicalMint,
              walletAtQuery,
              httpStatus: trWrap.status,
              body: trWrap.body,
            }
          );
          setTrades([]);
        }

        const volData = volRes as {
          byMint?: Record<string, string>;
          error?: string;
        };
        if (volData && !volData.error && volData.byMint) {
          const lamports = volData.byMint[canonicalMint] ?? "0";
          setVolume24hLamportsStr(lamports);
          console.log(
            "[volume24h client] mint",
            canonicalMint,
            "raw 24h lamports sum",
            lamports,
            "sol",
            lamportsStrToSol(lamports)
          );
        } else {
          setVolume24hLamportsStr("0");
        }

        setToken(next);
        requestTokenPhaseSync(canonicalMint);

        const slowest = timings.reduce(
          (a, b) => (a.ms >= b.ms ? a : b),
          timings[0] ?? { name: "none", ms: 0 }
        );
        console.log(
          "[perf:token] requests:",
          timings.length,
          "slowest:",
          slowest.name,
          `${slowest.ms.toFixed(0)}ms`,
          "parallel block:",
          `${(performance.now() - perfStart).toFixed(0)}ms`
        );

        if (needsRemoteMetadataFetch(next)) {
          setMetadataPending(true);
          try {
            const enriched = await enrichTokenWithFetchedMetadata(next);
            if (!cancelled) setToken(applyTokenMarketCapUsd(enriched, su));
          } finally {
            if (!cancelled) setMetadataPending(false);
          }
        } else {
          console.log("[metadata] token page: no remote URI fetch needed");
        }
      } catch {
        if (!cancelled) {
          const mock =
            MOCK_TOKENS.find(t => t.id === id || t.mint === id) ?? MOCK_TOKENS[0];
          setToken(mock);
          setMetadataPending(false);
          setTrades([]);
          setVolume24hLamportsStr("0");
        }
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [id, connection]);

  useEffect(() => {
    if (!token?.mint) return;
    const mintAddress = token.mint;
    let cancelled = false;

    async function refetchTradesAndVol(apiMint: string) {
      const walletAtQuery = walletLogRef.current;
      console.log("[trade-history] refetch start (token-wide)", {
        mintQueried: apiMint,
        walletAtQuery,
      });
      try {
        const [tradesWrap, volRes] = await Promise.all([
          fetch(
            `/api/tokens/${encodeURIComponent(apiMint)}/trades?limit=5000`
          ).then(async r => ({
            ok: r.ok,
            status: r.status,
            body: await r.json(),
          })),
          fetch(
            `/api/trades/volume-24h?mint=${encodeURIComponent(apiMint)}`
          ).then(r => r.json()),
        ]);
        const wouldBeRows =
          tradesWrap.ok && Array.isArray(tradesWrap.body)
            ? (tradesWrap.body as TradeHistoryRow[]).length
            : null;
        if (cancelled) {
          console.log("[trade-history] refetch ignored (stale: effect cancelled)", {
            mintQueried: apiMint,
            walletAtQuery,
            wouldBeRowCount: wouldBeRows,
            reason: "mint_or_connection_changed_or_unmount",
          });
          return;
        }
        if (tradesWrap.ok && Array.isArray(tradesWrap.body)) {
          const trData = tradesWrap.body as TradeHistoryRow[];
          console.log("[trade-history] refetch OK", {
            mintQueried: apiMint,
            walletAtQuery,
            rowCount: trData.length,
          });
          setTrades(trData.map(mapTradeHistoryRow));
        } else {
          console.warn(
            "[trade-history] refetch trades HTTP/error — keeping existing Trade History rows",
            {
              mintQueried: apiMint,
              walletAtQuery,
              httpStatus: tradesWrap.status,
              body: tradesWrap.body,
            }
          );
        }
        const volData = volRes as {
          byMint?: Record<string, string>;
          error?: string;
        };
        if (volData && !volData.error && volData.byMint) {
          setVolume24hLamportsStr(volData.byMint[apiMint] ?? "0");
        } else {
          console.warn("[trade-history] volume-24h refetch unusable — leaving prior value", {
            mintQueried: apiMint,
            walletAtQuery,
            volRes,
          });
        }
      } catch (e) {
        if (cancelled) {
          console.log("[trade-history] refetch catch ignored (cancelled)", {
            mintQueried: apiMint,
            walletAtQuery,
          });
          return;
        }
        console.warn(
          "[trade-history] refetch threw — keeping existing Trade History rows",
          { mintQueried: apiMint, walletAtQuery, error: e }
        );
      }
    }

    async function refreshAfterTradeComplete() {
      setPostTradeSyncing(true);
      try {
        const mintPk = new PublicKey(mintAddress);
        const program = getReadOnlyProgram(connection);
        const [pda] = getTokenStatePDA(mintPk);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const stateRes = await (program.account as any).tokenState.fetch(pda);
        if (cancelled) return;
        const canonicalMint = canonicalMintFromTokenState(stateRes, mintAddress);

        await Promise.all([
          (async () => {
            const sbRes = await fetch(
              `/api/tokens/${encodeURIComponent(canonicalMint)}`
            ).then(async r => {
              const j = await r.json();
              if (!r.ok) return null;
              if (
                j &&
                typeof j === "object" &&
                "error" in j &&
                !("mint" in j)
              ) {
                return null;
              }
              return j as SupabaseTokenRow;
            });
            if (cancelled) return;
            const su = solUsdRef.current;
            let next = tokenStateToToken(stateRes, canonicalMint, { solUsd: su });
            const sbRow =
              sbRes &&
              typeof sbRes === "object" &&
              "mint" in sbRes &&
              typeof (sbRes as { mint: unknown }).mint === "string"
                ? (sbRes as SupabaseTokenRow)
                : null;
            logTokenStateChainVsSupabase(
              canonicalMint.slice(0, 8) + "…",
              next,
              sbRow != null ? (sbRes as Record<string, unknown>) : null
            );
            next = mergeTokenMetadataFromSupabaseRow(next, sbRow);
            next = applyTokenMarketCapUsd(next, su);
            setToken(next);
            requestTokenPhaseSync(canonicalMint);
          })(),
          refetchTradesAndVol(canonicalMint),
        ]);
      } catch (e) {
        console.warn("[trade-history] post-trade token refresh failed:", e);
        if (!cancelled) await refetchTradesAndVol(mintAddress);
      } finally {
        if (!cancelled) setPostTradeSyncing(false);
      }
    }

    const onTradeComplete = (e: Event) => {
      const detail = (e as CustomEvent<{ mint?: string }>).detail;
      if (detail?.mint === mintAddress) void refreshAfterTradeComplete();
    };
    window.addEventListener("higher:trade-complete", onTradeComplete);
    return () => {
      cancelled = true;
      window.removeEventListener("higher:trade-complete", onTradeComplete);
    };
    // Trade History + listener: mint + RPC only — not `solUsd` or wallet (see `solUsdRef` / `walletLogRef`).
  }, [token?.mint, connection]);

  useEffect(() => {
    if (!token?.mint) return;
    console.log(
      "[volume24h client] formatted USD volume",
      volume24hUsdFormatted(volume24hLamportsStr, solUsd)
    );
  }, [token?.mint, volume24hLamportsStr, solUsd]);

  if (!token) {
    return validMintPk ? (
      <div className="min-h-screen px-6 py-8 max-w-6xl mx-auto">
        <div className="flex gap-4 mb-6 animate-pulse">
          <div className="w-12 h-12 rounded-lg bg-gray-200" />
          <div className="flex-1 space-y-2 pt-1">
            <div className="h-5 bg-gray-200 rounded w-48" />
            <div className="h-3 bg-gray-100 rounded w-32" />
          </div>
        </div>
        <div className="grid lg:grid-cols-3 gap-6">
          <div className="lg:col-span-2 space-y-4">
            <div className="h-36 bg-gray-100 rounded-lg" />
            <div className="h-52 bg-gray-100 rounded-lg" />
          </div>
          <div className="h-80 bg-gray-100 rounded-xl" />
        </div>
        <p className="text-center text-xs text-gray-400 mt-6">Loading token…</p>
      </div>
    ) : (
      <div className="flex items-center justify-center min-h-[60vh]">
        <p className="text-sm text-gray-400 animate-pulse">Loading token...</p>
      </div>
    );
  }

  const progress = calcBondingCurveProgress(token.solRaised, token.targetSOL);
  const graduated = token.phase === "graduated";
  const isGraduating = token.phase === "ready_to_graduate";
  const raiseGoal =
    solUsd != null ? formatUSD(token.targetSOL * solUsd) : `${token.targetSOL} SOL`;
  const omnipairPoolLive = hasRealOmnipairPoolOnChain(token);
  const omnipairSpotLive =
    graduated &&
    omnipairPoolLive &&
    omnipairSnapshot != null &&
    omnipairSnapshot.spotPriceSol > 0;
  const displayPriceSol = omnipairSpotLive
    ? omnipairSnapshot!.spotPriceSol
    : token.currentPrice;
  const priceUSD = solUsd != null ? displayPriceSol * solUsd : null;
  const bondingLiqUsdFallback =
    solUsd != null ? token.solRaised * solUsd + token.marketCap * 0.2 : null;
  const displayLiqUsd =
    omnipairSpotLive && solUsd != null && omnipairSnapshot
      ? (Number(omnipairSnapshot.reserveSolRaw) / 10 ** omnipairSnapshot.solDecimals) *
          solUsd +
        (Number(omnipairSnapshot.reserveProjectRaw) /
          10 ** omnipairSnapshot.projectTokenDecimals) *
          displayPriceSol *
          solUsd
      : bondingLiqUsdFallback;
  const displayMarketCapUsd =
    omnipairSpotLive && solUsd != null
      ? displayPriceSol * token.totalSupply * solUsd
      : token.marketCap;

  const volume24hUsdLabel = volume24hUsdFormatted(volume24hLamportsStr, solUsd);
  const volume24hSol = lamportsStrToSol(volume24hLamportsStr);

  const copyMint = () => {
    navigator.clipboard.writeText(token.mint);
    setCopied(true);
    toast.success("Copied");
    setTimeout(() => setCopied(false), 2000);
  };

  if (isGraduating) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center gap-6 px-4">
        <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-10 max-w-md w-full text-center">
          {token.imageUrl?.trim() ? (
            <div className="relative w-16 h-16 rounded-xl overflow-hidden mx-auto mb-4">
              <Image src={token.imageUrl} alt={token.name} fill className="object-cover" unoptimized />
            </div>
          ) : (
            <div className="w-16 h-16 rounded-xl bg-gray-100 flex items-center justify-center mx-auto mb-4">
              <span className="text-xl font-bold text-gray-400">{token.ticker.slice(0, 2).toUpperCase()}</span>
            </div>
          )}
          <h2 className="text-xl font-bold text-gray-900 mb-1">{token.name}</h2>
          <p className="text-sm text-gray-400 mb-6">{token.ticker} · Bonding target reached</p>

          <div className="flex items-center justify-center gap-2 mb-4">
            <div className="w-2 h-2 rounded-full bg-amber-400 animate-pulse" />
            <span className="text-sm font-semibold text-amber-600">Graduating to GAMM pool…</span>
          </div>

          <p className="text-xs text-gray-400 leading-relaxed">
            The bonding curve has filled. The graduation transaction is being
            submitted automatically. This page will refresh once the token is live
            on the GAMM pool.
          </p>

          <div className="mt-6 text-xs text-gray-300">
            {token.solRaised.toFixed(2)} / {token.targetSOL} SOL raised
          </div>
        </div>
      </div>
    );
  }

  if (!graduated) {
    return (
      <BondingPhasePage
        token={token}
        trades={trades}
        volume24hUsdLabel={volume24hUsdLabel}
        volume24hSol={volume24hSol}
        holderCount={holderCount}
        holderLoading={holderLoading}
        progress={progress}
        raiseGoal={raiseGoal}
        solUsd={solUsd}
        copied={copied}
        copyMint={copyMint}
        metadataPending={metadataPending}
        postTradeSyncing={postTradeSyncing}
      />
    );
  }

  return (
    <div className="min-h-screen px-4 sm:px-6 py-6">
      <div className="max-w-7xl mx-auto">

        {/* ── Token header bar ── */}
        <div className="bg-white rounded-lg p-4 mb-4">
          <div className="flex items-center gap-4 flex-wrap">
            {/* Token identity */}
            <div className="relative w-10 h-10 rounded-lg overflow-hidden flex-shrink-0 bg-gray-100">
              {metadataPending && !token.imageUrl?.trim() ? (
                <div className="absolute inset-0 bg-gray-200 animate-pulse" aria-hidden />
              ) : token.imageUrl?.trim() ? (
                <Image src={token.imageUrl} alt={token.name} fill className="object-cover" unoptimized />
              ) : (
                <div className="absolute inset-0 flex items-center justify-center text-[10px] font-semibold text-gray-400" aria-hidden>
                  {token.ticker.slice(0, 2).toUpperCase()}
                </div>
              )}
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
                <span className="font-bold text-gray-900 text-lg">{formatUSD(displayMarketCapUsd)}</span>
              </div>
              <div className="hidden sm:flex items-center gap-4 text-xs text-gray-400">
                <span>
                  Price{" "}
                  <span className="text-gray-700 font-medium">
                    {priceUSD != null ? `$${priceUSD.toFixed(6)}` : `${displayPriceSol.toFixed(8)} SOL`}
                  </span>
                  {omnipairSpotLive ? (
                    <span className="text-gray-300 font-normal ml-1">· pool</span>
                  ) : null}
                </span>
                <span>
                  Liq{" "}
                  <span className="text-gray-700 font-medium">
                    {displayLiqUsd != null ? formatUSD(displayLiqUsd) : "—"}
                  </span>
                </span>
                <span>
                  Volume (24h){" "}
                  <span className="text-gray-700 font-medium">{volume24hUsdLabel}</span>
                </span>
                <span>
                  Holders{" "}
                  <span className="text-gray-700 font-medium">
                    {holderLoading ? "…" : formatNumber(holderCount ?? 0)}
                  </span>
                </span>
              </div>
            </div>
          </div>
        </div>

        <TokenWalletBalancesRow mint={token.mint} ticker={token.ticker} />

        {/* ── Main layout: chart+table left, trade+stats right ── */}
        <div className="grid lg:grid-cols-[1fr_340px] gap-4 items-start lg:items-stretch">

          {/* Left column — flex col so About stretches to match right side */}
          <div className="flex flex-col gap-4">
            <div className="flex-shrink-0">
              <TokenCandlestickChart mint={token.mint} ticker={token.ticker} solUsd={solUsd} />
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
              <div className="max-h-[calc(7*(2.5rem+1px))] overflow-y-auto">
                {trades.length > 0 ? (
                  trades.map(trade => (
                    <div key={trade.id} className="grid grid-cols-8 gap-2 px-4 py-2.5 text-xs border-b border-gray-50 last:border-0 hover:bg-gray-50 transition-colors">
                      <span className="text-gray-400">{timeAgo(trade.timestamp)}</span>
                      <span className={cn("font-semibold", trade.type === "buy" ? "text-green-500" : "text-red-500")}>
                        {trade.type}
                        {trade.source === "omnipair" ? (
                          <span className="text-[9px] font-medium text-amber-700 ml-0.5">·GAMM</span>
                        ) : null}
                      </span>
                      <span className="text-gray-700">
                        {solUsd != null ? `$${(trade.price * solUsd).toFixed(2)}` : "—"}
                      </span>
                      <span className="text-gray-600">{formatNumber(trade.tokenAmount)}</span>
                      <span className="text-gray-600">{trade.solAmount.toFixed(3)}</span>
                      <span className="text-gray-600">{formatUSD(displayMarketCapUsd)}</span>
                      <span className="text-gray-400 truncate" title={trade.trader}>
                        {trade.trader ? shortenAddress(trade.trader) : "—"}
                      </span>
                      <span className="text-right">
                        <a href={`https://solscan.io/tx/${trade.txSignature}`} target="_blank" rel="noopener noreferrer" className="text-gray-300 hover:text-gray-500">
                          <ArrowUpRight size={11} />
                        </a>
                      </span>
                    </div>
                  ))
                ) : (
                  <div className="px-4 py-12 text-center text-sm text-gray-400">
                    No trades in Supabase for this mint yet.
                  </div>
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
              {metadataPending &&
              !String(token.about || token.description || "").trim() ? (
                <div className="space-y-2 animate-pulse" aria-hidden>
                  <div className="h-3 bg-gray-100 rounded w-full" />
                  <div className="h-3 bg-gray-100 rounded w-[92%]" />
                  <div className="h-3 bg-gray-100 rounded w-4/5" />
                </div>
              ) : (
                <p className="text-sm text-gray-600 leading-relaxed whitespace-pre-line">
                  {token.about || token.description}
                </p>
              )}
            </div>
          </div>

          {/* Right column */}
          <div className="flex flex-col gap-4">
            {/* Trade panel */}
            <TradingInterface
              token={token}
              spotPriceSol={
                omnipairPoolLive &&
                omnipairSnapshot &&
                omnipairSnapshot.spotPriceSol > 0
                  ? omnipairSnapshot.spotPriceSol
                  : null
              }
              omnipairPoolSnapshot={
                omnipairPoolLive ? omnipairSnapshot ?? null : null
              }
              initialMode={tradingInitialMode}
              initialLeverageDirection={tradingLeverageDir}
            />

            {omnipairPoolLive ? (
              <OmnipairPoolCard
                ticker={token.ticker}
                snapshot={omnipairSnapshot}
                loading={omnipairPoolLoading}
                error={omnipairPoolError}
              />
            ) : null}

            {!omnipairPoolLive ? (
              <div className="rounded-lg border border-amber-100 bg-amber-50/80 px-3 py-3 text-xs text-amber-900 leading-relaxed">
                <p className="font-semibold mb-1">Omnipair pool not linked on-chain yet</p>
                <p className="text-amber-800/90 mb-2">
                  Graduation is complete, but <code className="text-[10px]">gamm_pool</code> is still unset.
                  Run <code className="text-[10px]">bootstrap_omnipair_pool</code> to move vault liquidity into a
                  real Omnipair pair (requires ~0.2 SOL + rent in the connected wallet for Omnipair fees).
                </p>
                {graduated ? (
                  <button
                    type="button"
                    disabled={
                      omnipairBootstrapBusy ||
                      !walletAdapter.connected ||
                      !walletAdapter.publicKey ||
                      !walletAdapter.signTransaction
                    }
                    onClick={async () => {
                      if (
                        !walletAdapter.publicKey ||
                        !walletAdapter.signTransaction
                      ) {
                        toast.error("Connect a wallet that can sign transactions");
                        return;
                      }
                      const lpUri =
                        token.metadataUri?.trim().startsWith("http")
                          ? token.metadataUri!.trim()
                          : `https://higher.run/token/${encodeURIComponent(token.mint)}`;
                      setOmnipairBootstrapBusy(true);
                      try {
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
                        const sig = await sendBootstrapOmnipairPoolTx({
                          connection,
                          wallet: anchorWallet,
                          mint: new PublicKey(token.mint),
                          ticker: token.ticker,
                          lpUri,
                        });
                        toast.success(`Omnipair bootstrap submitted: ${sig.slice(0, 8)}…`);
                        const program = getReadOnlyProgram(connection);
                        const [pda] = getTokenStatePDA(new PublicKey(token.mint));
                        const stateRes = await (program.account as any).tokenState.fetch(pda);
                        const su =
                          typeof solUsd === "number" && solUsd > 0 ? solUsd : undefined;
                        const next = tokenStateToToken(stateRes, token.mint, { solUsd: su });
                        setToken(applyTokenMarketCapUsd(next, solUsd));
                        void requestTokenPhaseSync(token.mint);
                      } catch (e) {
                        console.error(e);
                        toast.error(
                          e instanceof Error ? e.message : "Omnipair bootstrap failed"
                        );
                      } finally {
                        setOmnipairBootstrapBusy(false);
                      }
                    }}
                    className="mb-2 w-full rounded-md bg-amber-700 px-3 py-2 text-[11px] font-semibold text-white hover:bg-amber-800 disabled:opacity-40 disabled:pointer-events-none"
                  >
                    {omnipairBootstrapBusy ? "Bootstrapping…" : "Bootstrap Omnipair pool"}
                  </button>
                ) : null}
                <p className="text-[10px] text-amber-700/80 font-mono">
                  Omnipair program: {OMNIPAIR_PROGRAM_ID_STR}
                </p>
              </div>
            ) : null}

            <div className="bg-white rounded-lg p-4 space-y-2 text-xs">
              <div className="flex justify-between">
                <span className="text-gray-400">Creator fees (on-chain accumulator)</span>
                <span className="font-semibold text-gray-700 tabular-nums">
                  {token.creatorFeesEarned?.toFixed(4) ?? "—"} SOL
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-400">Volume (24h) est. fee (bonding history)</span>
                <span className="text-gray-700 font-medium tabular-nums">
                  {solUsd != null && solUsd > 0
                    ? formatUSD(volume24hSol * solUsd * 0.01)
                    : "—"}
                </span>
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
  token,
  trades,
  volume24hUsdLabel,
  volume24hSol,
  holderCount,
  holderLoading,
  progress,
  raiseGoal,
  solUsd,
  copied,
  copyMint,
  metadataPending,
  postTradeSyncing,
}: {
  token: any;
  trades: any[];
  volume24hUsdLabel: string;
  volume24hSol: number;
  holderCount: number | null;
  holderLoading: boolean;
  progress: number;
  raiseGoal: string;
  solUsd: number | null;
  copied: boolean;
  copyMint: () => void;
  metadataPending: boolean;
  postTradeSyncing: boolean;
}) {
  const safeProgress = Number.isFinite(progress)
    ? Math.min(Math.max(0, progress), 100)
    : 0;
  const displayMcapUsd =
    solUsd != null &&
    solUsd > 0 &&
    Number.isFinite(token.currentPrice) &&
    token.currentPrice > 0 &&
    Number.isFinite(token.totalSupply)
      ? token.currentPrice * token.totalSupply * solUsd
      : token.marketCap;

  useEffect(() => {
    logBondingPanelDebug(token, solUsd);
  }, [
    token.mint,
    token.currentPrice,
    token.marketCap,
    token.totalSupply,
    token.solRaised,
    token.targetSOL,
    token.chainVirtualSolLamports,
    token.chainVirtualTokenReserveRaw,
    token.chainRealTokenReserveRaw,
    token.chainRealSolReserveLamports,
    solUsd,
  ]);

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
            {metadataPending && !token.imageUrl?.trim() ? (
              <div className="absolute inset-0 bg-gray-200 animate-pulse" aria-hidden />
            ) : token.imageUrl?.trim() ? (
              <Image src={token.imageUrl} alt={token.name} fill className="object-cover" unoptimized />
            ) : (
              <div className="absolute inset-0 flex items-center justify-center text-xs font-semibold text-gray-400" aria-hidden>
                {token.ticker.slice(0, 2).toUpperCase()}
              </div>
            )}
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h1 className="text-lg font-bold text-gray-900">{token.name}</h1>
              <span className="text-sm text-gray-400">{token.ticker}</span>
              <span className="bg-yellow-100 text-yellow-700 text-[10px] font-semibold px-2 py-0.5 rounded-full uppercase">Live</span>
            </div>
          </div>
        </div>

        <div className="mb-6">
          <div className="flex items-center justify-between text-xs mb-1.5">
            <span className="text-green-600 font-semibold">
              {solUsd != null ? formatUSD(token.solRaised * solUsd) : `${token.solRaised} SOL`}
            </span>
            <span className="text-gray-400">{safeProgress.toFixed(0)}%</span>
            <span className="text-gray-400">{raiseGoal} <span className="text-gray-300">goal</span></span>
          </div>
          <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
            <div className="h-full bg-green-500 rounded-full transition-all" style={{ width: `${safeProgress}%` }} />
          </div>
        </div>

        <div className="grid lg:grid-cols-3 gap-6">
          <div className="lg:col-span-2 space-y-5">
            <TokenCandlestickChart mint={token.mint} ticker={token.ticker} solUsd={solUsd} />
            <div className="bg-white rounded-lg p-6">
              <h2 className="text-sm font-bold text-gray-900 mb-4">About</h2>
              {metadataPending &&
              !String(token.about || token.description || "").trim() ? (
                <div className="space-y-2 animate-pulse" aria-hidden>
                  <div className="h-3 bg-gray-100 rounded w-full" />
                  <div className="h-3 bg-gray-100 rounded w-[92%]" />
                  <div className="h-3 bg-gray-100 rounded w-4/5" />
                </div>
              ) : (
                <div className="text-sm text-gray-600 leading-relaxed whitespace-pre-line">
                  {token.about || token.description}
                </div>
              )}
            </div>
            <div className="bg-white rounded-lg overflow-hidden">
              <div className="px-6 py-4 border-b border-gray-100 flex items-center justify-between gap-2 flex-wrap">
                <div className="flex items-center gap-2 min-w-0">
                  <h2 className="text-sm font-bold text-gray-900">Trade History</h2>
                  {postTradeSyncing && (
                    <span className="text-[10px] text-amber-600 font-medium shrink-0">
                      Updating market data…
                    </span>
                  )}
                </div>
                               <span className="text-[10px] text-gray-400 tabular-nums">
                  Volume (24h){" "}
                  <span className="text-gray-600 font-semibold">{volume24hUsdLabel}</span>
                </span>
              </div>
              {trades.length > 0 ? (
                <div className="max-h-[calc(7*(3rem+1px))] overflow-y-auto">
                  {trades.map((trade: any) => (
                    <div key={trade.id} className="flex items-center gap-4 px-6 py-3 text-xs border-b border-gray-50 last:border-0 hover:bg-gray-50">
                      <span className={cn("font-semibold w-8 shrink-0", trade.type === "buy" ? "text-green-500" : "text-red-500")}>{trade.type}</span>
                      <span className="text-gray-600 flex-1 min-w-0">{formatNumber(trade.tokenAmount)} {token.ticker}</span>
                      <span className="text-gray-600 shrink-0 tabular-nums">{trade.solAmount.toFixed(4)} SOL</span>
                      <span className="text-gray-400 shrink-0" title={trade.trader}>
                        {trade.trader ? shortenAddress(trade.trader) : "—"}
                      </span>
                      <span className="text-gray-400 shrink-0">{timeAgo(trade.timestamp)}</span>
                      <a
                        href={`https://solscan.io/tx/${trade.txSignature}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-gray-300 hover:text-gray-500 shrink-0"
                        aria-label="View transaction"
                      >
                        <ArrowUpRight size={11} />
                      </a>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="px-6 py-10 text-center text-sm text-gray-400">
                  No trades in Supabase for this mint yet.
                </div>
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
                <div className="flex justify-between gap-2">
                  <span className="text-gray-400 shrink-0">Price</span>
                  <span className="font-bold text-gray-900 text-right tabular-nums">
                    {formatSolPerTokenPrice(token.currentPrice)}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-400">Market Cap</span>
                  <span className="font-bold text-gray-900 tabular-nums">
                    {formatUSD(displayMcapUsd)}
                  </span>
                </div>
                <div className="flex justify-between"><span className="text-gray-400">Raise Goal</span><span className="text-gray-600">{raiseGoal}</span></div>
                <div className="flex justify-between">
                  <span className="text-gray-400">Supply</span>
                  <span className="text-gray-600 tabular-nums">
                    {Number(token.totalSupply).toLocaleString("en-US", {
                      maximumFractionDigits: 0,
                      minimumFractionDigits: 0,
                    })}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-400">Holders</span>
                  <span className="text-gray-600 font-medium tabular-nums">
                    {holderLoading ? "…" : formatNumber(holderCount ?? 0)}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-400">Volume (24h)</span>
                  <span className="text-gray-600 font-medium tabular-nums">
                    {volume24hUsdLabel}
                    {solUsd == null && volume24hSol > 0 ? ` (${volume24hSol.toFixed(2)} SOL)` : ""}
                  </span>
                </div>
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
