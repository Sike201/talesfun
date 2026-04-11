"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import Image from "next/image";
import { Sparkles, TrendingUp, CheckCircle2, Users, Globe, Bird, Search } from "lucide-react";
import { MOCK_TOKENS } from "@/lib/mockData";
import { formatUSD, formatNumber, shortenAddress, timeAgo } from "@/lib/utils";
import { Token } from "@/types";

function TokenRow({ token }: { token: Token }) {
  const progress = (token.solRaised / token.targetSOL) * 100;
  const graduated = token.phase === "graduated";

  return (
    <Link href={`/token/${token.id}`}>
      <div className="flex items-center gap-3 px-5 py-4 hover:bg-gray-50 transition-colors cursor-pointer border-b border-gray-100 last:border-0">
        <div className="relative w-11 h-11 rounded-full overflow-hidden flex-shrink-0 bg-gray-200">
          <Image src={token.imageUrl} alt={token.name} fill className="object-cover" unoptimized />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-semibold text-[15px] text-gray-900 truncate">{token.name}</span>
            <span className="text-xs text-gray-400 font-medium">{token.ticker}</span>
            {token.website && (
              <Globe size={10} className="text-gray-300" />
            )}
            {token.twitter && (
              <Bird size={10} className="text-gray-300" />
            )}
          </div>
          <div className="flex items-center gap-2 text-xs text-gray-400 mt-0.5">
            <span className="flex items-center gap-0.5"><Users size={10} /> {token.funders}</span>
            <span>Vol {formatUSD(token.volume24h ?? 0)}</span>
            <span>{timeAgo(token.createdAt)}</span>
          </div>
        </div>
        <div className="text-right flex-shrink-0">
          <span className="text-[15px] font-bold text-gray-900">MC {formatUSD(token.marketCap)}</span>
          {!graduated && (
            <div className="flex items-center gap-1.5 mt-1 justify-end">
              <div className="w-16 h-1.5 bg-gray-200 rounded-full overflow-hidden">
                <div className="h-full rounded-full" style={{ width: `${progress}%`, background: "rgba(175,145,90,0.45)" }} />
              </div>
              <span className="text-[10px] text-gray-400">{progress.toFixed(0)}%</span>
            </div>
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
}: {
  title: string;
  subtitle?: string;
  icon: React.ElementType;
  tokens: Token[];
  emptyText: string;
}) {
  return (
    <div className="flex flex-col min-w-[320px] flex-1">
      <div className="flex items-center justify-between px-1 pb-3">
        <div className="flex items-center gap-2">
          <Icon size={15} className="text-gray-400" />
          <h2 className="text-[15px] font-bold text-gray-900">{title}</h2>
          <span className="bg-gray-100 text-gray-500 text-[11px] font-semibold px-2 py-0.5 rounded-full">{tokens.length}</span>
        </div>
        {subtitle && (
          <span className="text-[11px] text-gray-400 font-medium">{subtitle}</span>
        )}
      </div>
      <div className="bg-white rounded-2xl flex-1 overflow-hidden min-h-[600px] flex flex-col">
        {tokens.length > 0 ? (
          <div className="flex-1">
            {tokens.map(token => (
              <TokenRow key={token.id} token={token} />
            ))}
          </div>
        ) : (
          <div className="flex-1 flex items-center justify-center text-sm text-gray-300">
            {emptyText}
          </div>
        )}
      </div>
    </div>
  );
}

export default function LaunchesPage() {
  const [query, setQuery] = useState("");

  const filtered = useMemo(
    () => MOCK_TOKENS.filter(t =>
      t.name.toLowerCase().includes(query.toLowerCase()) ||
      t.ticker.toLowerCase().includes(query.toLowerCase())
    ),
    [query]
  );

  const inception = useMemo(
    () => filtered.filter(t => t.phase === "bonding" && t.marketCap < 10000),
    [filtered]
  );
  const interest = useMemo(
    () => filtered.filter(t => t.phase === "bonding" && t.marketCap >= 10000),
    [filtered]
  );
  const migrated = useMemo(
    () => filtered.filter(t => t.phase === "graduated"),
    [filtered]
  );

  return (
    <div className="px-6 py-8">
      <div className="max-w-5xl mx-auto">
        <div className="flex items-center justify-between mb-6">
          <h1 className="text-xl font-bold text-gray-900">Explore</h1>
          <div className="relative">
            <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none" />
            <input
              type="text"
              placeholder="Search tokens..."
              value={query}
              onChange={e => setQuery(e.target.value)}
              className="pl-8 pr-4 py-2 text-sm bg-white rounded-lg border border-gray-200 text-gray-900 placeholder-gray-400 focus:outline-none focus:border-gray-300 w-52"
            />
          </div>
        </div>

        <div className="flex gap-5 overflow-x-auto pb-4">
          <KanbanColumn
            title="Inception"
            icon={Sparkles}
            tokens={inception}
            emptyText="No ideas found"
          />
          <KanbanColumn
            title="Interest"
            subtitle="Below $100k"
            icon={TrendingUp}
            tokens={interest}
            emptyText="No projects yet"
          />
          <KanbanColumn
            title="Migrated"
            subtitle="Above $100k"
            icon={CheckCircle2}
            tokens={migrated}
            emptyText="No migrations yet"
          />
        </div>
      </div>
    </div>
  );
}
