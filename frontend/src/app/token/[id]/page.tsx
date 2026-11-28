"use client";

import { use, useState, useEffect, useMemo, useRef } from "react";
import { useSearchParams } from "next/navigation";
import Image from "next/image";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import { MOCK_TOKENS } from "@/lib/mockData";
import { DEMO_TOKEN, isDemoMarketMint } from "@/lib/demoMarket";
import {
  formatUSD, formatNumber, shortenAddress, calcBondingCurveProgress,
  formatSolPerTokenPrice,
  formatTokenPriceUsd,
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
import TokenCandlestickChart from "@/components/ui/TokenCandlestickChart";
import TradingInterface from "@/components/ui/TradingInterface";
import TokenGraduatedFeed from "@/components/token/TokenGraduatedFeed";
import TokenGraduatedInfo from "@/components/token/TokenGraduatedInfo";
import { FIXED_SUPPLY, Token, Trade } from "@/types";
import { Copy, CheckCircle2 } from "lucide-react";
import toast from "react-hot-toast";
import { logTokenStateChainVsSupabase } from "@/lib/debugChainVsSupabase";
import { logBondingPanelDebug } from "@/lib/bondingCurveQuote";
import {
  bondingLiquidityUsd,
  graduatedLiquidityUsd,
  isThinLiquidity,
  marketCapUsdFromSpot,
} from "@/lib/marketStats";
import { readLocalTradeHistory } from "@/lib/recentActivityLocal";

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

function activityTypeFromSide(side: string | null | undefined): Trade["type"] {
  if (side === "sell" || side === "long" || side === "short" || side === "borrow") {
    return side;
  }
  return "buy";
}

function tradesFromLocalHistory(mint: string): Trade[] {
  return readLocalTradeHistory(mint).map((row, i) => {
    const solRaw = Number(row.sol_amount_raw ?? 0);
    const tokenRaw = Number(row.token_amount_raw ?? 0);
    const price =
      typeof row.price_sol === "number" && row.price_sol > 0
        ? row.price_sol
        : tokenRaw > 0
          ? solRaw / 1e9 / (tokenRaw / 1e6)
          : 0;
    return {
      id: row.signature || `local-${i}`,
      tokenMint: mint,
      trader: row.wallet ?? "",
      type: activityTypeFromSide(row.side),
      solAmount: Number.isFinite(solRaw) ? solRaw / 1e9 : 0,
      tokenAmount: Number.isFinite(tokenRaw) ? tokenRaw / 1e6 : 0,
      price,
      timestamp: new Date(row.timestamp),
      txSignature: row.signature,
      source: "omnipair",
    } satisfies Trade;
  });
}

function tradeRowRichness(t: Trade): number {
  let score = 0;
  if (t.trader) score += 2;
  if (t.solAmount > 0) score += 2;
  if (t.tokenAmount > 0) score += 2;
  if (t.price > 0) score += 1;
  return score;
}

function mergeApiAndLocalTrades(apiRows: Trade[], mint: string): Trade[] {
  const local = tradesFromLocalHistory(mint);
  const bySig = new Map<string, Trade>();
  // Prefer the richer row for a signature (never let sparse local clobber API).
  for (const t of [...local, ...apiRows]) {
    const key = t.txSignature || t.id;
    const prev = bySig.get(key);
    if (!prev || tradeRowRichness(t) >= tradeRowRichness(prev)) {
      bySig.set(key, t);
    }
  }
  return [...bySig.values()].sort(
    (a, b) => b.timestamp.getTime() - a.timestamp.getTime()
  );
}

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
    type: activityTypeFromSide(row.side),
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
    <div className="mb-4 flex flex-wrap gap-8 rounded-xl border border-white/10 bg-white/[0.04] px-4 py-3 text-sm">
      <div>
        <span className="mb-0.5 block text-[10px] font-semibold uppercase tracking-wider text-white/40">
          Wallet SOL
        </span>
        <span className="font-semibold tabular-nums text-white">
          {loading ? "…" : `${solBalanceDisplay} SOL`}
        </span>
      </div>
      <div>
        <span className="mb-0.5 block text-[10px] font-semibold uppercase tracking-wider text-white/40">
          Wallet {ticker}
        </span>
        <span className="font-semibold tabular-nums text-white">
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
  const feedSectionParam = searchParams.get("section");
  const feedInitialSection =
    feedSectionParam === "holders" || feedSectionParam === "liquidity"
      ? ("holders" as const)
      : feedSectionParam === "positions"
        ? ("positions" as const)
        : undefined;
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
  /** Live SPL mint supply (UI units) after graduation burns — preferred over token_state.total_supply. */
  const [mintSupplyUi, setMintSupplyUi] = useState<number | null>(null);
  const mintSupplyUiRef = useRef<number | null>(null);
  mintSupplyUiRef.current = mintSupplyUi;
  /** Summed lamports in last 24h for this mint (from Supabase). */
  const [volume24hLamportsStr, setVolume24hLamportsStr] = useState("0");
  const [postTradeSyncing, setPostTradeSyncing] = useState(false);
  const [copied, setCopied] = useState(false);
  const [metadataPending, setMetadataPending] = useState(false);
  const { count: holderCount, loading: holderLoading } = useMintHolderCount(
    token?.mint,
    true,
    token?.gammPool ? [token.gammPool] : []
  );
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
      setMintSupplyUi(null);
      if (isDemoMarketMint(id) || id === DEMO_TOKEN.id) {
        if (!cancelled) {
          setToken(DEMO_TOKEN);
          setMintSupplyUi(DEMO_TOKEN.totalSupply);
          setMetadataPending(false);
          setTrades([]);
          setVolume24hLamportsStr("120000000000");
        }
        return;
      }
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

        // Paint from chain immediately — don't block UI on Supabase / volume.
        const early = tokenStateToToken(stateRes, canonicalMint);
        if (!cancelled) {
          setToken(early);
          setTrades(mergeApiAndLocalTrades([], canonicalMint));
        }

        const [sbRes, tradesRes, volRes, solUsdJson, mintSupplyRes] = await Promise.all([
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
              `/api/tokens/${encodeURIComponent(canonicalMint)}/trades?limit=200${
                early.gammPool
                  ? `&gammPool=${encodeURIComponent(early.gammPool)}`
                  : ""
              }`
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
          timed(
            "mint_supply",
            connection
              .getTokenSupply(new PublicKey(canonicalMint))
              .catch(() => null)
          ),
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
        const supplyUi =
          mintSupplyRes &&
          typeof mintSupplyRes.value?.uiAmount === "number" &&
          mintSupplyRes.value.uiAmount > 0
            ? mintSupplyRes.value.uiAmount
            : mintSupplyRes?.value?.amount && mintSupplyRes.value.decimals != null
              ? Number(mintSupplyRes.value.amount) /
                10 ** mintSupplyRes.value.decimals
              : null;
        if (supplyUi != null && Number.isFinite(supplyUi) && supplyUi > 0) {
          next = { ...next, totalSupply: supplyUi };
          if (!cancelled) setMintSupplyUi(supplyUi);
        } else if (!cancelled) {
          setMintSupplyUi(null);
        }
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
          setTrades(
            mergeApiAndLocalTrades(trData.map(mapTradeHistoryRow), canonicalMint)
          );
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
          setTrades(tradesFromLocalHistory(canonicalMint));
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

  // Always refresh SPL mint supply — token_state.total_supply is NOT updated on burn.
  useEffect(() => {
    if (!validMintPk || isDemoMarketMint(id)) return;
    let cancelled = false;

    async function refreshMintSupply() {
      try {
        const supply = await connection.getTokenSupply(validMintPk!);
        const ui =
          supply.value.uiAmount != null && supply.value.uiAmount > 0
            ? supply.value.uiAmount
            : Number(supply.value.amount) / 10 ** supply.value.decimals;
        if (cancelled || !(Number.isFinite(ui) && ui > 0)) return;
        setMintSupplyUi(prev => (prev != null && Math.abs(prev - ui) < 1e-6 ? prev : ui));
        setToken(prev => {
          if (!prev || prev.mint !== validMintPk!.toBase58()) return prev;
          if (prev.totalSupply === ui) return prev;
          return applyTokenMarketCapUsd(
            { ...prev, totalSupply: ui },
            solUsdRef.current
          );
        });
      } catch {
        /* keep prior */
      }
    }

    void refreshMintSupply();
    const t = setInterval(refreshMintSupply, 20_000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [id, connection, validMintPk]);

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
        const gammQ = token?.gammPool
          ? `&gammPool=${encodeURIComponent(token.gammPool)}`
          : "";
        const [tradesWrap, volRes] = await Promise.all([
          fetch(
            `/api/tokens/${encodeURIComponent(apiMint)}/trades?limit=5000${gammQ}`
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
          setTrades(
            mergeApiAndLocalTrades(trData.map(mapTradeHistoryRow), apiMint)
          );
        } else {
          const local = tradesFromLocalHistory(apiMint);
          if (local.length) setTrades(local);
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
            const liveSupply = mintSupplyUiRef.current;
            if (liveSupply != null && liveSupply > 0) {
              next = { ...next, totalSupply: liveSupply };
            } else {
              try {
                const supply = await connection.getTokenSupply(
                  new PublicKey(canonicalMint)
                );
                const ui =
                  supply.value.uiAmount != null && supply.value.uiAmount > 0
                    ? supply.value.uiAmount
                    : Number(supply.value.amount) / 10 ** supply.value.decimals;
                if (Number.isFinite(ui) && ui > 0) {
                  next = { ...next, totalSupply: ui };
                  if (!cancelled) setMintSupplyUi(ui);
                }
              } catch {
                /* keep token_state supply */
              }
            }
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
  // Pump.fun-style: mcap = spot × **SPL mint supply** (post-burn) × SOL/USD.
  // token_state.total_supply stays at FIXED_SUPPLY (1B) after graduation burns —
  // never use that for graduated mcap or the ratio looks ~30× too high.
  const stateSupplyLooksStale =
    graduated &&
    Number.isFinite(token.totalSupply) &&
    token.totalSupply >= FIXED_SUPPLY * 0.99;
  const displaySupplyUi =
    mintSupplyUi != null && mintSupplyUi > 0
      ? mintSupplyUi
      : stateSupplyLooksStale
        ? 0
        : token.totalSupply;
  const displayMarketCapUsd =
    solUsd != null && displayPriceSol > 0 && displaySupplyUi > 0
      ? marketCapUsdFromSpot({
          spotSol: displayPriceSol,
          totalSupply: displaySupplyUi,
          solUsd,
        })
      : 0;
  const poolReserveSolUi =
    omnipairSpotLive && omnipairSnapshot
      ? Number(omnipairSnapshot.reserveSolRaw) /
        10 ** omnipairSnapshot.solDecimals
      : null;
  const displayLiqUsd =
    solUsd == null
      ? null
      : omnipairSpotLive && poolReserveSolUi != null
        ? graduatedLiquidityUsd({
            reserveSol: poolReserveSolUi,
            solUsd,
          })
        : bondingLiquidityUsd({ solRaised: token.solRaised, solUsd });
  const thinLiquidity =
    displayLiqUsd != null && isThinLiquidity(displayMarketCapUsd, displayLiqUsd);

  const volume24hUsdLabel = volume24hUsdFormatted(volume24hLamportsStr, solUsd);

  const copyMint = () => {
    navigator.clipboard.writeText(token.mint);
    setCopied(true);
    toast.success("Copied");
    setTimeout(() => setCopied(false), 2000);
  };

  if (isGraduating) {
    return (
      <div data-tales-page className="flex min-h-screen flex-col items-center justify-center gap-6 px-4">
        <div className="op-surface w-full max-w-md rounded-2xl p-10 text-center shadow-lg shadow-black/30">
          {token.imageUrl?.trim() ? (
            <div className="relative w-16 h-16 rounded-xl overflow-hidden mx-auto mb-4">
              <Image src={token.imageUrl} alt={token.name} fill className="object-cover" unoptimized />
            </div>
          ) : (
            <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-xl bg-white/10">
              <span className="text-xl font-bold text-white/45">{token.ticker.slice(0, 2).toUpperCase()}</span>
            </div>
          )}
          <h2 className="mb-1 text-xl font-semibold text-white">{token.name}</h2>
          <p className="mb-6 text-sm text-white/45">{token.ticker} · Bonding target reached</p>

          <div className="mb-4 flex items-center justify-center gap-2">
            <div className="h-2 w-2 animate-pulse rounded-full bg-amber-400" />
            <span className="text-sm font-semibold text-white/90">Opening the Omnipair market…</span>
          </div>

          <p className="text-xs leading-relaxed text-white/45">
            The bonding curve has filled. The graduation transaction is being
            submitted automatically. This page will refresh once the token is live
            on the GAMM pool.
          </p>

          <div className="mt-6 text-xs text-white/40">
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
        holderCount={holderCount}
        holderLoading={holderLoading}
        progress={progress}
        raiseGoal={raiseGoal}
        solUsd={solUsd}
        copied={copied}
        copyMint={copyMint}
        metadataPending={metadataPending}
        displayLiqUsd={displayLiqUsd}
        feedInitialSection={feedInitialSection}
      />
    );
  }

  return (
    <div data-tales-page className="min-h-screen">
      <div className="token-page">

        <header className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex gap-3.5">
            <div className="relative h-14 w-14 shrink-0 overflow-hidden rounded-full bg-white/[0.06]">
              {metadataPending && !token.imageUrl?.trim() ? (
                <div className="absolute inset-0 animate-pulse bg-zinc-800/80" aria-hidden />
              ) : token.imageUrl?.trim() ? (
                <Image src={token.imageUrl} alt={token.name} fill className="object-cover" unoptimized />
              ) : (
                <div className="absolute inset-0 flex items-center justify-center text-lg font-semibold text-white/45">
                  {token.ticker.slice(0, 2).toUpperCase()}
                </div>
              )}
            </div>
            <div className="min-w-0 pt-0.5">
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="text-[1.65rem] font-semibold tracking-tight text-white">
                  {token.name}
                </h1>
              </div>
              <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                <span className="rounded-md bg-white/[0.06] px-1.5 py-0.5 text-[11px] font-medium text-white/55">
                  ${token.ticker}
                </span>
                {isDemoMarketMint(token.mint) ? (
                  <span className="rounded-md bg-white/[0.06] px-1.5 py-0.5 text-[11px] font-medium text-white/45">
                    Demo
                  </span>
                ) : omnipairSpotLive ? (
                  <span className="inline-flex items-center gap-1 rounded-md bg-white/[0.06] px-1.5 py-0.5 text-[11px] font-medium text-white/55">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src="/icons/omnipair/favicon.svg"
                      alt=""
                      className="h-3.5 w-3.5"
                    />
                    Omnipair
                  </span>
                ) : (
                  <span className="rounded-md bg-amber-500/10 px-1.5 py-0.5 text-[11px] font-medium text-amber-200/80">
                    Pool pending
                  </span>
                )}
                <button
                  type="button"
                  onClick={copyMint}
                  className="ml-1 inline-flex items-center gap-1 font-mono text-[11px] text-white/35 transition-colors hover:text-white/65"
                >
                  {shortenAddress(token.mint, 4)}
                  {copied ? <CheckCircle2 size={12} className="text-emerald-400" /> : <Copy size={12} />}
                </button>
              </div>
            </div>
          </div>
        </header>

        <div className="token-stat-strip">
          <div>
            <p className="token-stat-label">Market cap</p>
            <p className="token-stat-value">
              {displaySupplyUi > 0 && displayMarketCapUsd > 0
                ? formatUSD(displayMarketCapUsd)
                : "…"}
            </p>
          </div>
          <div>
            <p className="token-stat-label">Price</p>
            <p className="token-stat-value tabular-nums">
              {priceUSD != null
                ? formatTokenPriceUsd(priceUSD)
                : formatSolPerTokenPrice(displayPriceSol)}
            </p>
          </div>
          <div>
            <p className="token-stat-label">24h volume</p>
            <p className="token-stat-value">{volume24hUsdLabel}</p>
          </div>
          <div>
            <p className="token-stat-label">Liquidity</p>
            <p className="token-stat-value inline-flex flex-wrap items-baseline gap-2">
              {displayLiqUsd != null ? formatUSD(displayLiqUsd) : "—"}
              {thinLiquidity ? (
                <span
                  className="rounded-md bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-300/90"
                  title="Small pool: prices move a lot on small trades"
                >
                  Thin
                </span>
              ) : null}
            </p>
          </div>
          <div>
            <p className="token-stat-label">Holders</p>
            <p className="token-stat-value">
              {holderLoading ? "…" : formatNumber(holderCount ?? 0)}
            </p>
          </div>
        </div>

        <div className="token-layout-main">
          <div>
            <TokenCandlestickChart
              mint={token.mint}
              ticker={token.ticker}
              solUsd={solUsd}
              livePriceSol={displayPriceSol > 0 ? displayPriceSol : null}
              totalSupply={displaySupplyUi}
            />

            <TokenGraduatedFeed
              token={{ ...token, totalSupply: displaySupplyUi }}
              trades={trades}
              solUsd={solUsd}
              holderCount={holderCount}
              holderLoading={holderLoading}
              omnipairPoolSnapshot={
                omnipairPoolLive ? omnipairSnapshot ?? null : null
              }
              poolReady={Boolean(
                omnipairPoolLive &&
                  omnipairSnapshot &&
                  omnipairSnapshot.spotPriceSol > 0
              )}
              initialSection={feedInitialSection}
            />

            <TokenGraduatedInfo
              token={token}
              copied={copied}
              onCopyMint={copyMint}
              omnipairSnapshot={omnipairPoolLive ? omnipairSnapshot : null}
              solUsd={solUsd}
              creatorFeesSol={token.creatorFeesEarned}
              showCreatorFees={Boolean(
                connectedWallet &&
                  (connectedWallet.toBase58() === token.creator ||
                    connectedWallet.toBase58() === token.creatorFeeRecipient)
              )}
              metadataPending={metadataPending}
            />
          </div>

          <div className="token-layout-rail flex flex-col gap-4">
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

            <TokenWalletBalancesRow mint={token.mint} ticker={token.ticker} />

            {!omnipairPoolLive && !isDemoMarketMint(token.mint) ? (
              <div className="rounded-xl bg-white/[0.04] px-3 py-3 text-xs leading-relaxed text-white/55">
                <p className="mb-1 font-semibold text-white/90">Omnipair market not open yet</p>
                <p className="mb-2">
                  The curve is finished. Opening the market releases the reserves, creates the Omnipair pool, and seeds it. The wallet pays about 0.2 SOL plus rent.
                </p>
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
                      const mintPk = new PublicKey(token.mint);
                      const [pda] = getTokenStatePDA(mintPk);
                      const [stateRes, supplyRes] = await Promise.all([
                        (program.account as any).tokenState.fetch(pda),
                        connection.getTokenSupply(mintPk).catch(() => null),
                      ]);
                      const su =
                        typeof solUsd === "number" && solUsd > 0 ? solUsd : undefined;
                      let next = tokenStateToToken(stateRes, token.mint, { solUsd: su });
                      const ui =
                        supplyRes?.value?.uiAmount != null && supplyRes.value.uiAmount > 0
                          ? supplyRes.value.uiAmount
                          : supplyRes?.value?.amount != null
                            ? Number(supplyRes.value.amount) /
                              10 ** supplyRes.value.decimals
                            : null;
                      if (ui != null && Number.isFinite(ui) && ui > 0) {
                        next = { ...next, totalSupply: ui };
                        setMintSupplyUi(ui);
                      }
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
                  className="tales-trade-cta !rounded-lg !py-2.5 !text-xs disabled:opacity-40"
                >
                  {omnipairBootstrapBusy ? "Opening market…" : "Open Omnipair market"}
                </button>
                <p className="mt-2 font-mono text-[10px] text-amber-200/60">
                  {OMNIPAIR_PROGRAM_ID_STR}
                </p>
              </div>
            ) : null}
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
  holderCount,
  holderLoading,
  progress,
  raiseGoal,
  solUsd,
  copied,
  copyMint,
  metadataPending,
  displayLiqUsd,
  feedInitialSection,
}: {
  token: Token;
  trades: Trade[];
  volume24hUsdLabel: string;
  holderCount: number | null;
  holderLoading: boolean;
  progress: number;
  raiseGoal: string;
  solUsd: number | null;
  copied: boolean;
  copyMint: () => void;
  metadataPending: boolean;
  displayLiqUsd: number | null;
  feedInitialSection?: "activity" | "holders" | "positions";
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
  const priceUSD =
    solUsd != null && token.currentPrice > 0
      ? token.currentPrice * solUsd
      : null;

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
    <div data-tales-page className="min-h-screen">
      <div className="token-page">
        <header className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex gap-3.5">
            <div className="relative h-14 w-14 shrink-0 overflow-hidden rounded-full bg-white/[0.06]">
              {metadataPending && !token.imageUrl?.trim() ? (
                <div className="absolute inset-0 animate-pulse bg-zinc-800/80" aria-hidden />
              ) : token.imageUrl?.trim() ? (
                <Image src={token.imageUrl} alt={token.name} fill className="object-cover" unoptimized />
              ) : (
                <div className="absolute inset-0 flex items-center justify-center text-lg font-semibold text-white/45">
                  {token.ticker.slice(0, 2).toUpperCase()}
                </div>
              )}
            </div>
            <div className="min-w-0 pt-0.5">
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="text-[1.65rem] font-semibold tracking-tight text-white">
                  {token.name}
                </h1>
              </div>
              <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                <span className="rounded-md bg-white/[0.06] px-1.5 py-0.5 text-[11px] font-medium text-white/55">
                  ${token.ticker}
                </span>
                <span className="rounded-md bg-amber-500/10 px-1.5 py-0.5 text-[11px] font-medium text-amber-200/80">
                  Bonding
                </span>
                <button
                  type="button"
                  onClick={copyMint}
                  className="ml-1 inline-flex items-center gap-1 font-mono text-[11px] text-white/35 transition-colors hover:text-white/65"
                >
                  {shortenAddress(token.mint, 4)}
                  {copied ? <CheckCircle2 size={12} className="text-emerald-400" /> : <Copy size={12} />}
                </button>
              </div>
            </div>
          </div>
        </header>

        <div className="mt-4 mb-1">
          <div className="mb-1.5 flex items-center justify-between text-[11px]">
            <span className="font-medium text-white/55">
              {solUsd != null
                ? formatUSD(token.solRaised * solUsd)
                : `${token.solRaised.toFixed(2)} SOL`}{" "}
              raised
            </span>
            <span className="tabular-nums text-white/40">
              {safeProgress.toFixed(0)}% · {raiseGoal} goal
            </span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-zinc-800">
            <div
              className="h-full rounded-full bg-emerald-500/90 transition-all"
              style={{ width: `${safeProgress}%` }}
            />
          </div>
        </div>

        <div className="token-stat-strip">
          <div>
            <p className="token-stat-label">Market cap</p>
            <p className="token-stat-value">
              {displayMcapUsd > 0 ? formatUSD(displayMcapUsd) : "…"}
            </p>
          </div>
          <div>
            <p className="token-stat-label">Price</p>
            <p className="token-stat-value tabular-nums">
              {priceUSD != null
                ? formatTokenPriceUsd(priceUSD)
                : formatSolPerTokenPrice(token.currentPrice)}
            </p>
          </div>
          <div>
            <p className="token-stat-label">24h volume</p>
            <p className="token-stat-value">{volume24hUsdLabel}</p>
          </div>
          <div>
            <p className="token-stat-label">Liquidity</p>
            <p className="token-stat-value">
              {displayLiqUsd != null ? formatUSD(displayLiqUsd) : "—"}
            </p>
          </div>
          <div>
            <p className="token-stat-label">Holders</p>
            <p className="token-stat-value">
              {holderLoading ? "…" : formatNumber(holderCount ?? 0)}
            </p>
          </div>
        </div>

        <div className="token-layout-main">
          <div>
            <TokenCandlestickChart
              mint={token.mint}
              ticker={token.ticker}
              solUsd={solUsd}
              livePriceSol={token.currentPrice > 0 ? token.currentPrice : null}
              totalSupply={
                Number.isFinite(token.totalSupply) && token.totalSupply > 0
                  ? token.totalSupply
                  : null
              }
            />

            <TokenGraduatedFeed
              token={token}
              trades={trades}
              solUsd={solUsd}
              holderCount={holderCount}
              holderLoading={holderLoading}
              omnipairPoolSnapshot={null}
              poolReady={false}
              initialSection={
                feedInitialSection === "holders" ? "holders" : "activity"
              }
              hidePositions
            />

            <TokenGraduatedInfo
              token={token}
              copied={copied}
              onCopyMint={copyMint}
              omnipairSnapshot={null}
              solUsd={solUsd}
              metadataPending={metadataPending}
            />
          </div>

          <div className="token-layout-rail flex flex-col gap-4">
            <TradingInterface token={token} modes={["swap"]} />
          </div>
        </div>
      </div>
    </div>
  );
}
