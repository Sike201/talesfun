"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useWallet } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { cn } from "@/lib/utils";
import { shortenAddress } from "@/lib/utils";
import { useState, useRef, useEffect } from "react";
import { LogOut, Copy, CheckCheck } from "lucide-react";
import { fraunces } from "@/lib/fonts";

const NAV = [
  { href: "/", label: "Home" },
  { href: "/launches", label: "Explore" },
  { href: "/create", label: "Launch" },
];

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
  const { connected, publicKey, disconnect } = useWallet();
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const isTales = isTalesPath(pathname);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const handleCopy = () => {
    if (!publicKey) return;
    navigator.clipboard.writeText(publicKey.toBase58());
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const handleDisconnect = () => {
    disconnect();
    setOpen(false);
  };

  return (
    <header
      className={cn(
        "sticky top-0 z-50 transition-colors",
        isTales ? "bg-black/80 backdrop-blur-xl" : ""
      )}
      style={isTales ? undefined : { backgroundColor: "#F3F4F6" }}
    >
      <div className="max-w-6xl mx-auto flex items-center justify-between h-14 px-6">
        <Link href="/" className="flex items-center gap-2.5 flex-shrink-0">
          {isTales ? (
            <img
              src="/tales-mark.png"
              alt=""
              className="h-7 w-7 select-none rounded-[6px]"
            />
          ) : (
            <img
              src="/higherdotrunlogo.png"
              alt=""
              className="h-[18px] w-auto"
            />
          )}
          <span
            className={cn(
              "tracking-tight leading-none",
              isTales
                ? cn(fraunces.className, "font-fraunces text-[23px] font-medium text-white")
                : "text-[17px] font-extrabold text-gray-900"
            )}
            style={
              isTales
                ? {
                    fontFamily:
                      "var(--font-fraunces), Fraunces, ui-serif, Georgia, serif",
                    fontVariationSettings: '"SOFT" 70, "WONK" 1, "opsz" 72',
                    letterSpacing: "-0.03em",
                  }
                : undefined
            }
          >
            {isTales ? "Tales" : "HIGHER.RUN"}
          </span>
        </Link>

        <nav className="hidden md:flex items-center gap-1 absolute left-1/2 -translate-x-1/2">
          {NAV.map(({ href, label }) => {
            const active =
              href === "/launches"
                ? pathname === "/launches" || pathname.startsWith("/token/")
                : pathname === href;
            return (
              <Link
                key={href}
                href={href}
                className={cn(
                  "px-4 py-1.5 rounded-md text-sm font-medium transition-colors",
                  isTales
                    ? active
                      ? "bg-white/15 text-white"
                      : "text-white/45 hover:bg-white/10 hover:text-white"
                    : active
                      ? "text-gray-900 bg-gray-100"
                      : "text-gray-400 hover:text-gray-700 hover:bg-gray-50"
                )}
              >
                {label}
              </Link>
            );
          })}
        </nav>

        <div className="flex items-center gap-3 flex-shrink-0">
          {connected && publicKey ? (
            <div className="relative" ref={dropdownRef}>
              <button
                onClick={() => setOpen(v => !v)}
                className={cn(
                  "flex items-center gap-2 px-2.5 py-1.5 rounded-lg transition-colors",
                  isTales ? "hover:bg-white/10" : "hover:bg-gray-100"
                )}
              >
                <div
                  className="w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-bold"
                  style={{ background: "rgba(175,145,90,0.18)", color: "#8a7050" }}
                >
                  {publicKey.toBase58().slice(0, 2).toUpperCase()}
                </div>
                <span
                  className={cn(
                    "text-sm hidden sm:block font-medium",
                    isTales ? "text-white/80" : "text-gray-600"
                  )}
                >
                  {shortenAddress(publicKey.toBase58(), 4)}
                </span>
                <svg
                  className={cn(
                    "w-3 h-3 transition-transform",
                    isTales ? "text-white/45" : "text-gray-400",
                    open && "rotate-180"
                  )}
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={2.5}
                >
                  <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                </svg>
              </button>

              {open && (
                <div className="absolute right-0 top-full mt-2 w-56 overflow-hidden rounded-xl border border-white/10 bg-zinc-950 py-1 shadow-lg z-50">
                  <div className="border-b border-white/10 px-4 py-2.5">
                    <p className="mb-0.5 text-[10px] uppercase tracking-wider text-white/40">
                      Connected wallet
                    </p>
                    <p className="truncate font-mono text-xs text-white/70">
                      {publicKey.toBase58()}
                    </p>
                  </div>
                  <button
                    onClick={handleCopy}
                    className="flex w-full items-center gap-3 px-4 py-2.5 text-sm text-white/70 transition-colors hover:bg-white/5"
                  >
                    {copied ? (
                      <CheckCheck size={14} className="text-emerald-400" />
                    ) : (
                      <Copy size={14} />
                    )}
                    {copied ? "Copied!" : "Copy address"}
                  </button>
                  <button
                    onClick={handleDisconnect}
                    className="flex w-full items-center gap-3 px-4 py-2.5 text-sm text-red-400 transition-colors hover:bg-red-500/10"
                  >
                    <LogOut size={14} />
                    Disconnect
                  </button>
                </div>
              )}
            </div>
          ) : (
            <WalletMultiButton />
          )}
        </div>
      </div>

      <nav className="fixed bottom-0 left-0 right-0 z-50 flex items-center justify-around bg-black/95 px-2 py-2 backdrop-blur-xl md:hidden">
        {NAV.map(({ href, label }) => {
          const active =
            href === "/launches"
              ? pathname === "/launches" || pathname.startsWith("/token/")
              : pathname === href;
          return (
            <Link
              key={href}
              href={href}
              className={cn(
                "rounded-md px-4 py-1.5 text-xs font-medium transition-colors",
                active ? "bg-white/15 text-white" : "text-white/45"
              )}
            >
              {label}
            </Link>
          );
        })}
      </nav>
    </header>
  );
}
