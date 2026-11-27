"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { cn, isSolanaAddress, shortenAddress } from "@/lib/utils";
import { useState, useRef, useEffect, useCallback } from "react";
import { LogOut, Copy, CheckCheck, Search, Wallet } from "lucide-react";

function isTalesPath(pathname: string) {
  return (
    pathname === "/" ||
    pathname === "/launches" ||
    pathname === "/create" ||
    pathname === "/docs" ||
    pathname.startsWith("/token/")
  );
}

export default function Navbar() {
  const pathname = usePathname();
  const router = useRouter();
  const { connected, publicKey, disconnect } = useWallet();
  const { setVisible } = useWalletModal();
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [search, setSearch] = useState("");
  const dropdownRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const isTales = isTalesPath(pathname);

  useEffect(() => {
    const q = new URLSearchParams(window.location.search).get("q");
    setSearch(q ?? "");
  }, [pathname]);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const pushSearch = useCallback(
    (value: string) => {
      const trimmed = value.trim();
      // Full mint / wallet pubkey → open the token page directly.
      if (trimmed && isSolanaAddress(trimmed)) {
        router.push(`/token/${trimmed}`);
        return;
      }
      if (pathname === "/" || pathname === "/launches") {
        const next = trimmed ? `/?q=${encodeURIComponent(trimmed)}` : "/";
        router.replace(next, { scroll: false });
      } else if (trimmed) {
        router.push(`/?q=${encodeURIComponent(trimmed)}`);
      }
    },
    [pathname, router]
  );

  const handleCopy = () => {
    if (!publicKey) return;
    navigator.clipboard.writeText(publicKey.toBase58());
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  if (!isTales) {
    return (
      <header className="sticky top-0 z-50 bg-[#0a0a0a]/90 backdrop-blur-xl">
        <div className="flex h-14 w-full items-center justify-between px-4 sm:px-6 lg:px-8">
          <Link href="/" className="text-sm font-semibold text-white">
            HIGHER.RUN
          </Link>
          <button
            type="button"
            onClick={() => setVisible(true)}
            aria-label="Connect wallet"
            className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-white/10 text-white/70 hover:border-white/20 hover:text-white"
          >
            <Wallet className="h-4 w-4" strokeWidth={1.75} />
          </button>
        </div>
      </header>
    );
  }

  return (
    <header className="sticky top-0 z-50 bg-[#0a0a0a]/90 backdrop-blur-xl">
      {/*
        3 equal columns: brand | search | actions.
        Search sits in the middle column so it is truly viewport-centered,
        independent of left/right content width.
      */}
      <div className="grid h-14 w-full grid-cols-[1fr_minmax(0,22rem)_1fr] items-center gap-3 px-4 sm:px-6 lg:px-8">
        <Link href="/" className="flex shrink-0 items-center gap-2.5 justify-self-start">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/tales-mark.png" alt="" className="h-6 w-6 rounded-[5px]" />
          <span className="hidden text-[15px] font-semibold tracking-tight text-white sm:block">
            Tales
          </span>
        </Link>

        <div className="relative hidden w-full md:block">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-white/30" />
          <input
            ref={searchRef}
            type="search"
            value={search}
            onChange={e => {
              setSearch(e.target.value);
              if (pathname === "/" || pathname === "/launches") {
                pushSearch(e.target.value);
              }
            }}
            onKeyDown={e => {
              if (e.key === "Enter") pushSearch(search);
            }}
            placeholder="Search tokens…"
            className="h-8 w-full rounded-full border border-white/[0.12] bg-transparent py-0 pl-9 pr-12 text-[13px] leading-8 text-white/90 placeholder:text-white/30 transition-colors focus:border-white/20 focus:bg-white/[0.03] focus:outline-none"
          />
          <kbd className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-[10px] font-medium tracking-wide text-white/25">
            ⌘K
          </kbd>
        </div>

        <div className="flex shrink-0 items-center justify-self-end gap-1.5 sm:gap-2">
          <Link
            href="/docs"
            className="inline-flex h-8 items-center px-2 text-[13px] font-medium text-white/45 transition-colors hover:text-white"
          >
            Docs
          </Link>
          <Link
            href="/create"
            className="inline-flex h-8 items-center rounded-full bg-white px-3.5 text-[12px] font-semibold text-[#0a0a0a] transition-opacity hover:opacity-90"
          >
            Launch
          </Link>
          {connected && publicKey ? (
            <div className="relative" ref={dropdownRef}>
              <button
                type="button"
                onClick={() => setOpen(v => !v)}
                className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-white/[0.12] text-white/70 transition-colors hover:border-white/20 hover:text-white"
                aria-label="Wallet menu"
              >
                <Wallet className="h-4 w-4" strokeWidth={1.75} />
              </button>
              {open ? (
                <div className="absolute right-0 top-full z-50 mt-2 w-48 overflow-hidden rounded-xl border border-white/10 bg-[#141414] py-1 shadow-2xl shadow-black/50">
                  <div className="border-b border-white/[0.06] px-3 py-2 text-[12px] text-white/45">
                    {shortenAddress(publicKey.toBase58(), 4)}
                  </div>
                  <button
                    type="button"
                    onClick={handleCopy}
                    className="flex w-full items-center gap-2 px-3 py-2 text-[13px] text-white/80 hover:bg-white/[0.05]"
                  >
                    {copied ? (
                      <CheckCheck size={14} className="text-white/70" />
                    ) : (
                      <Copy size={14} />
                    )}
                    {copied ? "Copied" : "Copy address"}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      disconnect();
                      setOpen(false);
                    }}
                    className="flex w-full items-center gap-2 px-3 py-2 text-[13px] text-white/50 hover:bg-white/[0.05] hover:text-white/80"
                  >
                    <LogOut size={14} />
                    Disconnect
                  </button>
                </div>
              ) : null}
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setVisible(true)}
              aria-label="Connect wallet"
              className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-white/[0.12] text-white/70 transition-colors hover:border-white/20 hover:text-white"
            >
              <Wallet className="h-4 w-4" strokeWidth={1.75} />
            </button>
          )}
        </div>
      </div>

      <div className="px-4 pb-3 md:hidden sm:px-6">
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-white/30" />
          <input
            type="search"
            value={search}
            onChange={e => {
              setSearch(e.target.value);
              pushSearch(e.target.value);
            }}
            placeholder="Search tokens…"
            className="h-9 w-full rounded-full border border-white/[0.12] bg-transparent pl-9 pr-3 text-[13px] leading-9 text-white placeholder:text-white/30 focus:outline-none"
          />
        </div>
      </div>
    </header>
  );
}