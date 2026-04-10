"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useWallet } from "@solana/wallet-adapter-react";
import { Home, LayoutGrid, Plus, User } from "lucide-react";
import { cn } from "@/lib/utils";

const NAV = [
  { href: "/", label: "Home", icon: Home },
  { href: "/launches", label: "Explore", icon: LayoutGrid },
  { href: "/create", label: "Launch", icon: Plus, accent: true },
  { href: "/dashboard", label: "Dashboard", icon: User },
];

export default function Sidebar() {
  const pathname = usePathname();
  const { connected, publicKey } = useWallet();

  return (
    <>
      {/* Desktop sidebar */}
      <aside className="hidden md:flex flex-col fixed left-0 top-0 h-screen w-[64px] bg-white border-r border-gray-100 z-50">
        {/* Logo — no bottom border */}
        <Link href="/" className="flex items-center justify-center h-14">
          <div className="w-7 h-7 rounded-lg bg-green-500 flex items-center justify-center flex-shrink-0">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
              <path d="M8 13L8 3M8 3L4 7M8 3L12 7" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </div>
        </Link>

        {/* Nav — vertically centered in remaining space */}
        <nav className="flex-1 flex flex-col items-center justify-center gap-1">
          {NAV.map(({ href, label, icon: Icon, accent }) => {
            const active = pathname === href;
            return (
              <Link
                key={href}
                href={href}
                className={cn(
                  "flex flex-col items-center justify-center gap-0.5 w-[52px] py-2.5 rounded-xl text-[10px] font-medium transition-colors",
                  active
                    ? "bg-gray-100 text-gray-900"
                    : accent
                    ? "text-green-600 hover:bg-green-50"
                    : "text-gray-400 hover:bg-gray-50 hover:text-gray-700"
                )}
              >
                <Icon size={18} strokeWidth={active ? 2.2 : 1.6} />
                <span>{label}</span>
              </Link>
            );
          })}
        </nav>

        {/* Bottom avatar */}
        <div className="flex flex-col items-center pb-4 gap-1">
          {connected && publicKey ? (
            <div className="w-8 h-8 rounded-full bg-green-500 flex items-center justify-center text-white text-[10px] font-bold cursor-pointer">
              {publicKey.toBase58().slice(0, 2).toUpperCase()}
            </div>
          ) : (
            <div className="w-8 h-8 rounded-full bg-gray-200 flex items-center justify-center text-gray-400 text-[10px]">
              ?
            </div>
          )}
        </div>
      </aside>

      {/* Mobile bottom nav */}
      <nav className="md:hidden fixed bottom-0 left-0 right-0 bg-white border-t border-gray-100 z-50 px-2 py-1.5 flex items-center justify-around">
        {NAV.map(({ href, label, icon: Icon, accent }) => {
          const active = pathname === href;
          return (
            <Link
              key={href}
              href={href}
              className={cn(
                "flex flex-col items-center gap-0.5 py-1 px-3 rounded-lg text-[10px] font-medium transition-colors",
                active ? "text-green-600" : accent ? "text-green-500" : "text-gray-400"
              )}
            >
              <Icon size={18} strokeWidth={active ? 2.2 : 1.6} />
              <span>{label}</span>
            </Link>
          );
        })}
      </nav>
    </>
  );
}
