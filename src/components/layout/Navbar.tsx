"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useWallet } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { cn } from "@/lib/utils";
import { shortenAddress } from "@/lib/utils";
import { useState, useRef, useEffect } from "react";
import { LogOut, Copy, CheckCheck } from "lucide-react";

const NAV = [
  { href: "/", label: "Home" },
  { href: "/launches", label: "Explore" },
  { href: "/create", label: "Launch" },
  { href: "/dashboard", label: "Dashboard" },
];

export default function Navbar() {
  const pathname = usePathname();
  const { connected, publicKey, disconnect } = useWallet();
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

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
    <header className="sticky top-0 z-50" style={{ backgroundColor: "#F3F4F6" }}>
      <div className="max-w-5xl mx-auto flex items-center justify-between h-14 px-6">
        {/* Logo */}
        <Link href="/" className="flex items-center gap-2 flex-shrink-0">
          <img src="/higherdotrunlogo.png" alt="higher.run" className="h-[18px] w-auto" />
          <span className="text-[17px] font-extrabold tracking-tight text-gray-900 leading-none">HIGHER.RUN</span>
        </Link>

        {/* Nav links — centered */}
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
                  active ? "text-gray-900 bg-gray-100" : "text-gray-400 hover:text-gray-700 hover:bg-gray-50"
                )}
              >
                {label}
              </Link>
            );
          })}
        </nav>

        {/* Right: wallet */}
        <div className="flex items-center gap-3 flex-shrink-0">
          {connected && publicKey ? (
            <div className="relative" ref={dropdownRef}>
              <button
                onClick={() => setOpen(v => !v)}
                className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg hover:bg-gray-100 transition-colors"
              >
                <div className="w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-bold" style={{ background: "rgba(175,145,90,0.18)", color: "#8a7050" }}>
                  {publicKey.toBase58().slice(0, 2).toUpperCase()}
                </div>
                <span className="text-sm text-gray-600 hidden sm:block font-medium">
                  {shortenAddress(publicKey.toBase58(), 4)}
                </span>
                <svg className={cn("w-3 h-3 text-gray-400 transition-transform", open && "rotate-180")} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                </svg>
              </button>

              {open && (
                <div className="absolute right-0 top-full mt-2 w-56 bg-white rounded-xl shadow-lg border border-gray-100 overflow-hidden z-50 py-1">
                  {/* Full address */}
                  <div className="px-4 py-2.5 border-b border-gray-50">
                    <p className="text-[10px] text-gray-400 uppercase tracking-wider mb-0.5">Connected wallet</p>
                    <p className="text-xs font-mono text-gray-600 truncate">{publicKey.toBase58()}</p>
                  </div>

                  {/* Copy address */}
                  <button
                    onClick={handleCopy}
                    className="w-full flex items-center gap-3 px-4 py-2.5 text-sm text-gray-600 hover:bg-gray-50 transition-colors"
                  >
                    {copied ? <CheckCheck size={14} className="text-green-500" /> : <Copy size={14} />}
                    {copied ? "Copied!" : "Copy address"}
                  </button>

                  {/* Disconnect */}
                  <button
                    onClick={handleDisconnect}
                    className="w-full flex items-center gap-3 px-4 py-2.5 text-sm text-red-500 hover:bg-red-50 transition-colors"
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

      {/* Mobile bottom nav */}
      <nav className="md:hidden fixed bottom-0 left-0 right-0 bg-white border-t border-gray-100 z-50 flex items-center justify-around px-2 py-2">
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
                "px-4 py-1.5 rounded-md text-xs font-medium transition-colors",
                active ? "text-gray-900 bg-gray-100" : "text-gray-400"
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
