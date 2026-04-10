"use client";

import { useWallet } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { Search, Bell } from "lucide-react";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { shortenAddress } from "@/lib/utils";

export default function TopBar() {
  const { connected, publicKey } = useWallet();
  const [searchQuery, setSearchQuery] = useState("");
  const router = useRouter();

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    if (searchQuery.trim()) {
      router.push(`/launches?q=${encodeURIComponent(searchQuery)}`);
    }
  };

  return (
    <header className="sticky top-0 z-40 bg-white">
      <div className="flex items-center justify-between h-14 px-6">
        <form onSubmit={handleSearch} className="flex-1 max-w-md">
          <div className="relative">
            <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
            <input
              type="text"
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              placeholder="Search by CA or ticker"
              className="w-full bg-gray-50 border border-gray-200 rounded-full pl-9 pr-4 py-2 text-sm text-gray-900 placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-green-500/20 focus:border-green-500 transition-all"
            />
          </div>
        </form>

        <div className="flex items-center gap-3 ml-4">
          {connected ? (
            <>
              <button className="p-2 rounded-full hover:bg-gray-100 transition-colors text-gray-400 hover:text-gray-600">
                <Bell size={18} />
              </button>
              <div className="flex items-center gap-2 pl-3">
                <div className="w-8 h-8 rounded-full bg-green-500 flex items-center justify-center text-white text-xs font-bold">
                  {publicKey?.toBase58().slice(0, 2).toUpperCase()}
                </div>
                <span className="text-sm font-medium text-gray-700 hidden sm:block">
                  {publicKey ? shortenAddress(publicKey.toBase58(), 4) : ""}
                </span>
              </div>
            </>
          ) : (
            <WalletMultiButton />
          )}
        </div>
      </div>
    </header>
  );
}
