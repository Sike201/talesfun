"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useConnection } from "@solana/wallet-adapter-react";
import {
  Sparkles,
  TrendingUp,
  CheckCircle2,
  Users,
  Globe,
  Bird,
  Search,
} from "lucide-react";
import { formatUSD, formatNumber, timeAgo, cn } from "@/lib/utils";
import { volume24hUsdFormatted } from "@/lib/volume24h";
import { useMintHolderCount } from "@/hooks/useMintHolderCount";
import {
  applyTokenMarketCapUsd,
  fetchAllTokenStatesAsTokens,
} from "@/lib/program";
import {
  enrichTokensWithMetadata,
  mergeTokenMetadataFromSupabaseRow,
  supabaseTokensByMint,
} from "@/lib/metadata";
import {
  setExploreListCache,
  takeExploreListCacheIfFresh,
} from "@/lib/exploreListCache";
import { extractIpfsPath, resolveToHttps } from "@/lib/ipfs";
import type { Token } from "@/types";
import { fraunces } from "@/lib/fonts";

const TOKEN_LIST_MAX_VISIBLE = 8;

function mediaSrc(raw?: string): string | undefined {
  const t = raw?.trim();
  if (!t) return undefined;
  const path = extractIpfsPath(t);
  if (path) return `/api/media?cid=${encodeURIComponent(path)}`;
  return resolveToHttps(t) || undefined;
}

function TokenAvatar({ src, ticker }: { src?: string; ticker: string }) {
  const [failed, setFailed] = useState(false);
  const resolved = mediaSrc(src);
  const show = !!resolved && !failed;

  return (
    <div className="relative h-11 w-11 shrink-0 overflow-hidden rounded-full bg-white/10">
      {show ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={resolved}
          alt=""
          className="h-full w-full object-cover"
          loading="lazy"
          referrerPolicy="no-referrer"
          onError={() => setFailed(true)}
        />
      ) : (
        <span className="flex h-full w-full items-center justify-center text-[10px] font-semibold text-white/45">
          {ticker.slice(0, 2).toUpperCase()}
        </span>
      )}
    </div>
  );
}

function TokenRow({
  token,
  solUsd,
  vol24hLamportsByMint,
  holdersEnabled,
}: {
  token: Token;
  solUsd: number | null;
  vol24hLamportsByMint: Record<string, string>;
  holdersEnabled: boolean;
}) {
  const { count: holderCount, loading: holderLoading } = useMintHolderCount(
    token.mint,
    holdersEnabled
  );
  const progress = Math.min(
    100,
    token.targetSOL > 0 ? (token.solRaised / token.targetSOL) * 100 : 0
  );
  const graduated = token.phase === "graduated";
  const graduating = token.phase === "ready_to_graduate";
  const lamports24h = vol24hLamportsByMint[token.mint] ?? "0";
  const vol24hLabel = volume24hUsdFormatted(lamports24h, solUsd);

  return (
    <Link href={`/token/${token.mint}`} className="block">
      <div className="flex items-center gap-3 rounded-xl px-3 py-3 transition-colors hover:bg-white/[0.04]">
        <TokenAvatar src={token.imageUrl} ticker={token.ticker} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-[14px] font-semibold text-white">
              {token.name}
            </span>
            <span className="shrink-0 text-xs font-medium text-white/40">
              ${token.ticker}
            </span>
            {token.website ? <Globe size={10} className="text-white/25" /> : null}
            {token.twitter ? <Bird size={10} className="text-white/25" /> : null}
          </div>
          <div className="mt-0.5 flex items-center gap-2 text-[11px] text-white/40">
            <span className="inline-flex items-center gap-0.5">
              <Users size={10} />
              {holderLoading ? "…" : formatNumber(holderCount ?? 0)}
            </span>
            <span>Vol {vol24hLabel}</span>
            <span>{timeAgo(token.createdAt)}</span>
          </div>
        </div>
        <div className="shrink-0 text-right">
          <p className="text-[13px] font-semibold tabular-nums text-[#e8c56a]">
            MC {formatUSD(token.marketCap)}
          </p>
          {graduating ? (
            <p className="mt-1 text-[10px] font-semibold text-amber-300">
              Graduating…
            </p>
          ) : !graduated ? (
            <div className="mt-1 flex items-center justify-end gap-1.5">
              <div className="h-1 w-14 overflow-hidden rounded-full bg-white/10">
                <div
                  className="h-full rounded-full bg-[#c8e6ff]"
                  style={{ width: `${progress}%` }}
                />
              </div>
              <span className="text-[10px] text-white/40">
                {progress.toFixed(0)}%
              </span>
            </div>
          ) : (
            <p className="mt-1 text-[10px] font-medium text-emerald-400/80">
              Graduated
            </p>
          )}
        </div>
      </div>
    </Link>
  );
}

function KanbanColumn({
  title,
  subtitle,
  icon: Icon,
  tokens,
  emptyText,
  solUsd,
  vol24hLamportsByMint,
  holdersEnabled,
  loading,
}: {
  title: string;
  subtitle?: string;
  icon: React.ElementType;
  tokens: Token[];
  emptyText: string;
  solUsd: number | null;
  vol24hLamportsByMint: Record<string, string>;
  holdersEnabled: boolean;
  loading: boolean;
}) {
  return (
    <div className="flex min-w-[300px] flex-1 flex-col">
      <div className="mb-3 flex items-center justify-between px-1">
        <div className="flex items-center gap-2">
          <Icon size={15} className="text-white/45" />
          <h2 className="text-[15px] font-semibold text-white">{title}</h2>
          <span className="rounded-full bg-white/10 px-2 py-0.5 text-[11px] font-semibold text-white/55">
            {loading ? "…" : tokens.length}
          </span>
        </div>
        {subtitle ? (
          <span className="text-[11px] font-medium text-white/35">{subtitle}</span>
        ) : null}
      </div>

      <div className="flex min-h-[28rem] flex-1 flex-col overflow-hidden rounded-2xl bg-black/55 backdrop-blur-md">
        {loading ? (
          <div className="space-y-1 p-2">
            {Array.from({ length: 5 }).map((_, i) => (
              <div
                key={i}
                className="flex animate-pulse items-center gap-3 rounded-xl px-3 py-3"
              >
                <div className="h-11 w-11 rounded-full bg-white/10" />
                <div className="flex-1 space-y-2">
                  <div className="h-3 w-2/3 rounded bg-white/10" />
                  <div className="h-2.5 w-1/2 rounded bg-white/[0.06]" />
                </div>
              </div>
            ))}
          </div>
        ) : tokens.length > 0 ? (
          <div
            className="min-h-0 overflow-y-auto overflow-x-hidden overscroll-y-contain p-1.5"
            style={{ maxHeight: `calc(4.85rem * ${TOKEN_LIST_MAX_VISIBLE})` }}
          >
            {tokens.map(token => (
              <TokenRow
                key={token.mint}
                token={token}
                solUsd={solUsd}
                vol24hLamportsByMint={vol24hLamportsByMint}
                holdersEnabled={holdersEnabled}
              />
            ))}
          </div>
        ) : (
          <div className="flex flex-1 items-center justify-center px-4 text-sm text-white/30">
            {emptyText}
          </div>
        )}
      </div>
    </div>
  );
}

export default function LaunchesPage() {
  const { connection } = useConnection();
  const [tokens, setTokens] = useState<Token[] | null>(null);
  const [solUsd, setSolUsd] = useState<number | null>(null);
  const [vol24hLamportsByMint, setVol24hLamportsByMint] = useState<
    Record<string, string>
  >({});
  const [query, setQuery] = useState("");
  const [holdersGate, setHoldersGate] = useState(false);

  useEffect(() => {
    const cached = takeExploreListCacheIfFresh();
    if (cached) {
      setTokens(cached.tokens);
      setSolUsd(cached.solUsd);
      setVol24hLamportsByMint(cached.vol24hLamportsByMint);
    }
  }, []);

  useEffect(() => {
    const t = window.setTimeout(() => setHoldersGate(true), 380);
    return () => window.clearTimeout(t);
  }, []);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const [solUsdJson, volJson, sbJson, chainList] = await Promise.all([
          fetch("/api/sol-usd").then(r => r.json()).catch(() => ({})),
          fetch("/api/trades/volume-24h").then(r => r.json()).catch(() => ({})),
          fetch("/api/tokens?limit=500").then(r => r.json()).catch(() => []),
          fetchAllTokenStatesAsTokens(connection, undefined).catch(() => []),
        ]);
        if (cancelled) return;

        let su: number | undefined;
        if (typeof solUsdJson.solUsd === "number" && solUsdJson.solUsd > 0) {
          su = solUsdJson.solUsd;
        }
        setSolUsd(su ?? null);

        const vj = volJson as { byMint?: Record<string, string>; error?: string };
        const bm =
          vj.byMint && typeof vj.byMint === "object" && !vj.error ? vj.byMint : {};
        setVol24hLamportsByMint(bm);

        const sbRows = Array.isArray(sbJson) ? sbJson : [];
        const byMint = supabaseTokensByMint(sbRows);
        const merged = (chainList ?? [])
          .map(t => mergeTokenMetadataFromSupabaseRow(t, byMint.get(t.mint)))
          .map(t => applyTokenMarketCapUsd(t, su));
        setTokens(merged);
        setExploreListCache({
          tokens: merged,
          vol24hLamportsByMint: bm,
          solUsd: su ?? null,
        });

        void enrichTokensWithMetadata(merged, null).then(enriched => {
          if (!cancelled) {
            const next = enriched.map(t => applyTokenMarketCapUsd(t, su));
            setTokens(next);
            setExploreListCache({
              tokens: next,
              vol24hLamportsByMint: bm,
              solUsd: su ?? null,
            });
          }
        });
      } catch {
        if (!cancelled) setTokens([]);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [connection]);

  const filtered = useMemo(() => {
    const list = tokens ?? [];
    const q = query.trim().toLowerCase();
    if (!q) return list;
    return list.filter(
      t =>
        t.name.toLowerCase().includes(q) ||
        t.ticker.toLowerCase().includes(q)
    );
  }, [query, tokens]);

  const newTokens = useMemo(
    () =>
      filtered.filter(
        t =>
          (t.phase === "bonding" || t.phase === "ready_to_graduate") &&
          t.marketCap < 10_000
      ),
    [filtered]
  );
  const interest = useMemo(
    () =>
      filtered.filter(
        t =>
          (t.phase === "bonding" || t.phase === "ready_to_graduate") &&
          t.marketCap >= 10_000
      ),
    [filtered]
  );
  const migrated = useMemo(
    () => filtered.filter(t => t.phase === "graduated"),
    [filtered]
  );

  const loading = tokens === null;

  return (
    <div data-tales-page className="flex min-h-[calc(100vh-3.5rem)] flex-col">
      <div className="mx-auto w-full max-w-6xl flex-1 px-6 pb-12 pt-8">
        <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <h1
            className={cn(fraunces.className, "font-fraunces text-[1.65rem] font-medium tracking-tight text-white sm:text-[1.85rem]")}
            style={{
              fontFamily:
                "var(--font-fraunces), Fraunces, ui-serif, Georgia, serif",
              fontVariationSettings: '"SOFT" 55, "WONK" 1, "opsz" 144',
              letterSpacing: "-0.03em",
            }}
          >
            Explore markets
          </h1>
          <div className="relative w-full sm:w-auto">
            <Search
              size={13}
              className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-white/35"
            />
            <input
              type="text"
              placeholder="Search tokens…"
              value={query}
              onChange={e => setQuery(e.target.value)}
              className="w-full rounded-full bg-white/[0.06] py-2 pl-8 pr-3 text-sm text-white placeholder:text-white/30 focus:outline-none sm:w-56"
            />
          </div>
        </div>

        <div className="flex gap-5 overflow-x-auto pb-2">
          <KanbanColumn
            title="New"
            icon={Sparkles}
            tokens={newTokens}
            emptyText="No ideas found"
            solUsd={solUsd}
            vol24hLamportsByMint={vol24hLamportsByMint}
            holdersEnabled={holdersGate}
            loading={loading}
          />
          <KanbanColumn
            title="Interest"
            subtitle="Below $100k"
            icon={TrendingUp}
            tokens={interest}
            emptyText="No projects yet"
            solUsd={solUsd}
            vol24hLamportsByMint={vol24hLamportsByMint}
            holdersEnabled={holdersGate}
            loading={loading}
          />
          <KanbanColumn
            title="Migrated"
            subtitle="Graduated"
            icon={CheckCircle2}
            tokens={migrated}
            emptyText="No migrations yet"
            solUsd={solUsd}
            vol24hLamportsByMint={vol24hLamportsByMint}
            holdersEnabled={holdersGate}
            loading={loading}
          />
        </div>
      </div>

      <footer className="mx-auto mt-auto w-full max-w-6xl px-6 pb-10">
        <div
          className="relative overflow-hidden rounded-[1.25rem]"
          style={{
            minHeight: 200,
            height: "clamp(200px, 28vw, 260px)",
            backgroundColor: "#000",
          }}
        >
          <div
            aria-hidden
            className="absolute inset-0"
            style={{
              backgroundImage: "url(/explore-banner.png)",
              backgroundSize: "cover",
              backgroundPosition: "center",
            }}
          />
          <div
            aria-hidden
            className="absolute inset-x-0 top-0 h-[55%]"
            style={{
              background:
                "linear-gradient(to bottom, #000 0%, rgba(0,0,0,0.65) 35%, rgba(0,0,0,0.2) 75%, transparent 100%)",
            }}
          />
          <div className="relative z-[1] flex h-full flex-col justify-between px-6 py-5 sm:px-8 sm:py-6">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
              <div className="max-w-sm">
                <p
                  className={cn(
                    fraunces.className,
                    "font-fraunces text-[1.15rem] font-medium text-white sm:text-[1.3rem]"
                  )}
                  style={{
                    fontFamily:
                      "var(--font-fraunces), Fraunces, ui-serif, Georgia, serif",
                    fontVariationSettings: '"SOFT" 55, "WONK" 1, "opsz" 72',
                    letterSpacing: "-0.02em",
                  }}
                >
                  Tales
                </p>
                <p className="mt-1.5 text-[13px] leading-relaxed text-white/60">
                  Bonding curves that graduate into Omnipair — long or short any
                  market.
                </p>
              </div>
              <nav className="flex flex-wrap gap-x-5 gap-y-2 text-[13px] font-medium">
                <Link
                  href="/docs"
                  className="text-white/70 transition-colors hover:text-white"
                >
                  Docs
                </Link>
                <Link
                  href="/create"
                  className="text-white/70 transition-colors hover:text-white"
                >
                  Launch
                </Link>
                <a
                  href="https://x.com/Talesdotfun"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-white/70 transition-colors hover:text-white"
                >
                  X
                </a>
                <a
                  href="https://x.com/Talesdotfun"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-white/70 transition-colors hover:text-white"
                >
                  Community
                </a>
              </nav>
            </div>
            <p className="text-[11px] text-white/35">
              © {new Date().getFullYear()} Tales
            </p>
          </div>
        </div>
      </footer>
    </div>
  );
}
