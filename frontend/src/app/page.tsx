"use client";

import { useEffect, useState, useMemo } from "react";
import Link from "next/link";
import Image from "next/image";
import { useConnection } from "@solana/wallet-adapter-react";
import {
  applyTokenMarketCapUsd,
  fetchAllTokenStatesAsTokens,
} from "@/lib/program";
import {
  enrichTokensWithMetadata,
  mergeTokenMetadataFromSupabaseRow,
  supabaseTokensByMint,
} from "@/lib/metadata";
import { setExploreListCache } from "@/lib/exploreListCache";
import type { Token } from "@/types";
import HomeTokenCard from "@/components/landing/HomeTokenCard";
import { fraunces } from "@/lib/fonts";
import { cn } from "@/lib/utils";

type MarketTab = "moving" | "graduated" | "marketcap";

const TABS: { id: MarketTab; label: string }[] = [
  { id: "moving", label: "Moving" },
  { id: "graduated", label: "Graduated" },
  { id: "marketcap", label: "Market cap" },
];

export default function HomePage() {
  const { connection } = useConnection();
  const [tokens, setTokens] = useState<Token[] | null>(null);
  const [solUsd, setSolUsd] = useState<number | null>(null);
  const [vol24hLamportsByMint, setVol24hLamportsByMint] = useState<
    Record<string, string>
  >({});
  const [tab, setTab] = useState<MarketTab>("moving");

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const [solUsdJson, sbJson, chainList, volJson] = await Promise.all([
          fetch("/api/sol-usd").then(r => r.json()).catch(() => ({})),
          fetch("/api/tokens?limit=100").then(r => r.json()).catch(() => []),
          fetchAllTokenStatesAsTokens(connection, undefined).catch(() => []),
          fetch("/api/trades/volume-24h").then(r => r.json()).catch(() => ({})),
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
        setExploreListCache({ tokens: merged, vol24hLamportsByMint: bm, solUsd: su ?? null });

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
        if (!cancelled) {
          setTokens([]);
          setVol24hLamportsByMint({});
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [connection]);

  const filteredTokens = useMemo(() => {
    if (!tokens?.length) return [];
    let list = [...tokens];

    if (tab === "moving") {
      list = list.filter(t => BigInt(vol24hLamportsByMint[t.mint] ?? "0") > BigInt(0));
      list.sort((a, b) => {
        const va = BigInt(vol24hLamportsByMint[a.mint] ?? "0");
        const vb = BigInt(vol24hLamportsByMint[b.mint] ?? "0");
        if (va === vb) return b.marketCap - a.marketCap;
        return va > vb ? -1 : 1;
      });
    } else if (tab === "graduated") {
      list = list.filter(t => t.phase === "graduated");
      list.sort((a, b) => b.marketCap - a.marketCap);
    } else {
      list.sort((a, b) => b.marketCap - a.marketCap);
    }

    return list.slice(0, 24);
  }, [tokens, tab, vol24hLamportsByMint]);

  return (
    <div data-tales-page>
      <section
        className="home-hero-wrap"
        style={{ maxWidth: "72rem", margin: "0 auto", padding: "1.25rem 1.5rem 0" }}
      >
        <div
          className="home-hero-card"
          style={{
            position: "relative",
            overflow: "hidden",
            borderRadius: "1.25rem",
            minHeight: 320,
            height: "clamp(320px, 44vw, 460px)",
            border: "none",
            backgroundColor: "#000000",
          }}
        >
          <div
            aria-hidden
            style={{
              position: "absolute",
              inset: 0,
              zIndex: 0,
              backgroundImage: "url(/hero-banner.png)",
              backgroundSize: "cover",
              backgroundPosition: "center",
              backgroundRepeat: "no-repeat",
            }}
          />
          <div
            aria-hidden
            style={{
              position: "absolute",
              inset: 0,
              zIndex: 1,
              background:
                "linear-gradient(180deg, rgba(0,0,0,0.35) 0%, rgba(0,0,0,0.45) 55%, rgba(0,0,0,0.55) 100%)",
            }}
          />
          <div
            className="home-hero-content"
            style={{
              position: "relative",
              zIndex: 2,
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              textAlign: "center",
              minHeight: "100%",
              padding: "clamp(2.75rem, 5vw, 3.75rem) 1.75rem",
              margin: "0 auto",
              maxWidth: "40rem",
              gap: 0,
            }}
          >
            <div
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "0.45rem",
                borderRadius: 999,
                padding: "0.4rem 0.85rem 0.4rem 0.7rem",
                background: "rgba(0,0,0,0.38)",
                boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.14)",
                backdropFilter: "blur(10px)",
                color: "rgba(255,255,255,0.72)",
                fontSize: "0.78rem",
                fontWeight: 500,
                letterSpacing: "0.01em",
              }}
            >
              <span style={{ color: "rgba(255,255,255,0.55)" }}>powered by</span>
              <Image
                src="/omnipairlogo.svg"
                alt=""
                width={15}
                height={15}
                className="brightness-0 invert opacity-95"
              />
              <span style={{ color: "#ffffff", fontWeight: 600 }}>Omnipair</span>
            </div>

            <p
              className={cn(fraunces.className, "font-fraunces")}
              style={{
                margin: "1.75rem 0 0",
                maxWidth: "22ch",
                fontFamily:
                  "var(--font-fraunces), Fraunces, ui-serif, Georgia, serif",
                fontVariationSettings: '"SOFT" 55, "WONK" 1, "opsz" 144',
                fontSize: "clamp(1.85rem, 4.2vw, 2.65rem)",
                fontWeight: 500,
                lineHeight: 1.15,
                letterSpacing: "-0.03em",
                color: "#ffffff",
                textShadow: "0 1px 18px rgba(0,0,0,0.45)",
              }}
            >
              Long or short any graduated token.
            </p>

            <p
              style={{
                margin: "1.35rem 0 0",
                maxWidth: "32rem",
                fontSize: "0.98rem",
                lineHeight: 1.55,
                color: "rgba(255,255,255,0.7)",
              }}
            >
              Bonding curve launches that graduate into real Omnipair markets —
              with long and short built in.
            </p>

            <div
              className="home-hero-actions"
              style={{
                marginTop: "2.15rem",
                display: "flex",
                flexWrap: "wrap",
                gap: "0.75rem",
                justifyContent: "center",
              }}
            >
              <Link href="#markets" className="home-btn-primary">
                Long &amp; short markets
              </Link>
              <Link href="/create" className="home-btn-secondary">
                Launch token
              </Link>
            </div>
          </div>
        </div>
      </section>

      <section id="markets" className="home-markets">
        <div className="home-markets-head">
          <div>
            <h2 className="home-section-title">Tokens</h2>
          </div>
          <div className="flex flex-wrap gap-1">
            {TABS.map(t => (
              <button
                key={t.id}
                type="button"
                onClick={() => setTab(t.id)}
                className={cn(
                  "rounded-lg px-3 py-1.5 text-xs font-medium transition-colors",
                  tab === t.id
                    ? "bg-white/15 text-white"
                    : "bg-transparent text-white/50 hover:text-white"
                )}
              >
                {t.label}
              </button>
            ))}
          </div>
        </div>

        {tokens === null ? (
          <p className="home-empty">Loading markets…</p>
        ) : filteredTokens.length === 0 ? (
          <p className="home-empty">
            No tokens in this view yet.{" "}
            <Link href="/create" style={{ color: "#67e8f9" }}>
              Launch one
            </Link>
          </p>
        ) : (
          <div className="home-token-grid">
            {filteredTokens.map((token, i) => (
              <HomeTokenCard
                key={token.mint}
                token={token}
                solUsd={solUsd}
                vol24hLamports={vol24hLamportsByMint[token.mint] ?? "0"}
                rank={tab === "marketcap" || tab === "moving" ? i + 1 : undefined}
              />
            ))}
          </div>
        )}

        <div className="home-explore-link">
          <Link href="/launches">Full explore →</Link>
        </div>
      </section>
    </div>
  );
}
