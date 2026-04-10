"use client";

import { useState, useRef } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import {
  Upload, Bird, Send, Globe, Zap, Shield, BadgeDollarSign,
  AlertCircle, CheckCircle2, ArrowRight, Info, Lock
} from "lucide-react";
import { cn } from "@/lib/utils";
import { FIXED_SUPPLY, GRADUATION_SOL, CREATOR_FEE_BPS } from "@/types";
import toast from "react-hot-toast";
import Image from "next/image";
import {
  Keypair,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import {
  MINT_SIZE,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountInstruction,
  createInitializeMint2Instruction,
  createMintToInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";

interface FormData {
  name: string;
  ticker: string;
  description: string;
  image: File | null;
  imagePreview: string;
  twitter: string;
  telegram: string;
  website: string;
  creatorFeeRecipient: string;
}

export default function CreatePage() {
  const { connection } = useConnection();
  const { connected, publicKey, sendTransaction } = useWallet();
  const [loading, setLoading] = useState(false);
  const [launched, setLaunched] = useState(false);
  const [launchedMint, setLaunchedMint] = useState("");
  const [ownershipUSD, setOwnershipUSD] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [form, setForm] = useState<FormData>({
    name: "", ticker: "", description: "", image: null, imagePreview: "",
    twitter: "", telegram: "", website: "", creatorFeeRecipient: "",
  });

  const set = (key: keyof FormData, value: string) =>
    setForm(prev => ({ ...prev, [key]: value }));

  const handleImageUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) { toast.error("Image must be under 5MB"); return; }
    const reader = new FileReader();
    reader.onload = ev => {
      setForm(prev => ({ ...prev, image: file, imagePreview: ev.target?.result as string }));
    };
    reader.readAsDataURL(file);
  };

  const validate = (): string | null => {
    if (!form.name.trim()) return "Token name is required";
    if (!form.ticker.trim()) return "Ticker is required";
    if (form.ticker.length > 10) return "Ticker must be 10 characters or less";
    if (!form.description.trim()) return "Description is required";
    return null;
  };

  const handleLaunch = async () => {
    if (!connected || !publicKey) return;
    const err = validate();
    if (err) { toast.error(err); return; }

    setLoading(true);
    try {
      const mintKeypair = Keypair.generate();
      const mintRent = await connection.getMinimumBalanceForRentExemption(MINT_SIZE);
      const creatorTokenAccount = getAssociatedTokenAddressSync(mintKeypair.publicKey, publicKey);

      const tx = new Transaction().add(
        SystemProgram.createAccount({
          fromPubkey: publicKey,
          newAccountPubkey: mintKeypair.publicKey,
          space: MINT_SIZE,
          lamports: mintRent,
          programId: TOKEN_PROGRAM_ID,
        }),
        createInitializeMint2Instruction(mintKeypair.publicKey, 6, publicKey, null, TOKEN_PROGRAM_ID),
        createAssociatedTokenAccountInstruction(publicKey, creatorTokenAccount, publicKey, mintKeypair.publicKey),
        createMintToInstruction(mintKeypair.publicKey, creatorTokenAccount, publicKey, BigInt(FIXED_SUPPLY) * BigInt(10 ** 6))
      );

      const signature = await sendTransaction(tx, connection, { signers: [mintKeypair] });
      await connection.confirmTransaction(signature, "confirmed");

      const storedLaunches = JSON.parse(localStorage.getItem("higher.run.launches") ?? "[]");
      storedLaunches.unshift({
        id: mintKeypair.publicKey.toBase58(), mint: mintKeypair.publicKey.toBase58(),
        name: form.name, ticker: form.ticker, description: form.description,
        imageUrl: form.imagePreview, creator: publicKey.toBase58(),
        creatorFeeRecipient: form.creatorFeeRecipient || publicKey.toBase58(),
        twitter: form.twitter || undefined, telegram: form.telegram || undefined,
        website: form.website || undefined, createdAt: new Date().toISOString(),
        phase: "bonding", solRaised: 0, targetSOL: GRADUATION_SOL, tokensSold: 0,
        totalSupply: FIXED_SUPPLY, currentPrice: 0.0000038, marketCap: 0,
      });
      localStorage.setItem("higher.run.launches", JSON.stringify(storedLaunches));

      setLaunchedMint(mintKeypair.publicKey.toBase58());
      setLaunched(true);
      toast.success("Token minted on Solana devnet!");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Launch failed");
    } finally {
      setLoading(false);
    }
  };

  if (launched) {
    return (
      <div className="max-w-lg mx-auto px-6 py-20">
        <div className="bg-white rounded-2xl p-8 text-center">
          <div className="w-14 h-14 rounded-full flex items-center justify-center mx-auto mb-5" style={{ background: "rgba(175,145,90,0.12)", color: "#8a7050" }}>
            <CheckCircle2 size={28} />
          </div>
          <h2 className="text-2xl font-bold text-gray-900 mb-1">Token Launched!</h2>
          <p className="text-sm text-gray-500 mb-6">
            <span className="font-semibold text-gray-900">${form.ticker}</span> is live on devnet.
          </p>
          <div className="bg-white rounded-xl p-3 mb-6 text-left">
            <p className="text-[10px] text-gray-400 uppercase tracking-wider mb-1">Mint Address</p>
            <p className="font-mono text-xs text-gray-700 break-all">{launchedMint}</p>
          </div>
          <div className="flex gap-2">
            <a href={`/token/${launchedMint}`}
              className="flex-1 flex items-center justify-center gap-2 py-2.5 rounded-xl text-sm font-semibold transition-colors"
              style={{ background: "rgba(175,145,90,0.12)", color: "#8a7050", boxShadow: "inset 0 0 0 1px rgba(175,145,90,0.2)" }}>
              View Token <ArrowRight size={14} />
            </a>
            <button
              onClick={() => {
                setLaunched(false);
                setForm({ name: "", ticker: "", description: "", image: null, imagePreview: "",
                  twitter: "", telegram: "", website: "", creatorFeeRecipient: "" });
              }}
              className="border border-gray-200 text-gray-600 px-4 py-2.5 rounded-xl text-sm font-medium hover:bg-gray-50 transition-colors">
              Launch Another
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-lg mx-auto px-6 py-10">
      <div className="mb-8">
        <h1 className="text-xl font-bold text-gray-900">New Project</h1>
        <p className="text-sm text-gray-400 mt-1">10M fixed supply · Anti-rug · Perpetual royalties</p>
      </div>

      <div className="bg-white rounded-2xl p-6 space-y-5">
        {/* Image upload */}
        <div>
          <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">Token Image</label>
          <div
            onClick={() => fileInputRef.current?.click()}
            className={cn(
              "border border-dashed rounded-xl p-5 text-center cursor-pointer transition-colors",
              form.imagePreview ? "border-amber-200 bg-amber-50/20" : "border-gray-200 hover:border-gray-300 hover:bg-gray-50"
            )}
          >
            {form.imagePreview ? (
              <div className="flex items-center justify-center gap-3">
                <div className="relative w-12 h-12 rounded-lg overflow-hidden">
                  <Image src={form.imagePreview} alt="preview" fill className="object-cover" />
                </div>
                <div className="text-left">
                  <p className="text-sm font-medium text-gray-700">{form.image?.name}</p>
                  <p className="text-[10px] text-gray-400">Click to change</p>
                </div>
              </div>
            ) : (
              <div>
                <Upload size={20} className="text-gray-300 mx-auto mb-1.5" />
                <p className="text-sm text-gray-500">Upload image</p>
                <p className="text-[10px] text-gray-400">PNG, JPG, GIF · Max 5MB</p>
              </div>
            )}
          </div>
          <input ref={fileInputRef} type="file" accept="image/*" onChange={handleImageUpload} className="hidden" />
        </div>

        {/* Name + Ticker */}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1.5">Name</label>
            <input
              type="text" value={form.name} onChange={e => set("name", e.target.value)}
              placeholder="Cosmic Vibes"
              className="w-full bg-gray-50 rounded-xl px-3 py-2.5 text-sm text-gray-900 placeholder:text-gray-300 focus:outline-none focus:ring-2 focus:ring-amber-300/30 focus:border-amber-300 transition-all"
            />
          </div>
          <div>
            <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1.5">Ticker</label>
            <div className="relative">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm font-semibold text-gray-300">$</span>
              <input
                type="text" value={form.ticker}
                onChange={e => set("ticker", e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""))}
                placeholder="CVIBE" maxLength={10}
                className="w-full bg-gray-50 rounded-xl pl-7 pr-3 py-2.5 text-sm text-gray-900 font-semibold placeholder:text-gray-300 placeholder:font-normal focus:outline-none focus:ring-2 focus:ring-amber-300/30 focus:border-amber-300 transition-all"
              />
            </div>
          </div>
        </div>

        {/* Description */}
        <div>
          <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1.5">Description</label>
          <textarea
            value={form.description} onChange={e => set("description", e.target.value)}
            placeholder="What is your project about?"
            rows={3} maxLength={500}
            className="w-full bg-gray-50 rounded-xl px-3 py-2.5 text-sm text-gray-900 placeholder:text-gray-300 focus:outline-none focus:ring-2 focus:ring-amber-300/30 focus:border-amber-300 transition-all resize-none"
          />
          <p className="text-[10px] text-gray-400 text-right mt-0.5">{form.description.length}/500</p>
        </div>

        {/* Socials */}
        <div className="space-y-3">
          <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wider">Socials (optional)</label>
          {[
            { key: "twitter" as const, icon: Bird, placeholder: "@yourhandle" },
            { key: "telegram" as const, icon: Send, placeholder: "t.me/yourgroup" },
            { key: "website" as const, icon: Globe, placeholder: "https://yourproject.xyz" },
          ].map(({ key, icon: Icon, placeholder }) => (
            <div key={key} className="relative">
              <Icon size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
              <input
                type="text" value={form[key]} onChange={e => set(key, e.target.value)}
                placeholder={placeholder}
                className="w-full bg-gray-50 rounded-xl pl-9 pr-3 py-2 text-sm text-gray-900 placeholder:text-gray-300 focus:outline-none focus:ring-2 focus:ring-amber-300/30 focus:border-amber-300 transition-all"
              />
            </div>
          ))}
        </div>

        {/* Fee recipient */}
        <div>
          <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1.5">
            Fee Recipient <span className="font-normal lowercase text-gray-400">defaults to your wallet</span>
          </label>
          <input
            type="text" value={form.creatorFeeRecipient} onChange={e => set("creatorFeeRecipient", e.target.value)}
            placeholder={publicKey?.toBase58() || "Wallet address..."}
            className="w-full bg-gray-50 rounded-xl px-3 py-2.5 text-sm text-gray-900 font-mono placeholder:text-gray-300 placeholder:font-sans focus:outline-none focus:ring-2 focus:ring-amber-300/30 focus:border-amber-300 transition-all"
          />
        </div>

        {/* Ownership / Dev buy */}
        {(() => {
          const SOL_PRICE = 140;
          const LAUNCH_PRICE_SOL = 0.0000038;
          const PRESETS = [
            { pct: 1,  tokens: 100_000 },
            { pct: 10, tokens: 1_000_000 },
            { pct: 30, tokens: 3_000_000 },
            { pct: 50, tokens: 5_000_000 },
            { pct: 80, tokens: 8_000_000 },
          ].map(p => ({ ...p, usd: Math.round(p.tokens * LAUNCH_PRICE_SOL * SOL_PRICE) }));

          const usdNum = parseFloat(ownershipUSD) || 0;
          const solEquiv = usdNum > 0 ? (usdNum / SOL_PRICE).toFixed(4) : null;

          return (
            <div>
              <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wider mb-0.5">
                Ownership
              </label>
              <p className="text-xs text-gray-400 mb-3">Buy tokens before anyone else.</p>

              {/* Dollar input */}
              <div className="bg-gray-50 rounded-xl px-3 py-3 mb-2 flex items-center gap-1">
                <span className="text-lg font-semibold text-gray-300">$</span>
                <input
                  type="number"
                  value={ownershipUSD}
                  onChange={e => setOwnershipUSD(e.target.value)}
                  placeholder="0.00"
                  className="flex-1 bg-transparent text-lg font-semibold text-gray-900 placeholder:text-gray-300 focus:outline-none"
                />
              </div>

              {/* SOL equivalent */}
              <p className="text-xs text-gray-400 mb-3">
                {solEquiv ? `≈ ${solEquiv} SOL` : "≈ 0 SOL"}
              </p>

              {/* Quick % presets */}
              <div className="flex gap-1.5">
                {PRESETS.map(({ pct, usd }) => (
                  <button
                    key={pct}
                    onClick={() => setOwnershipUSD(ownershipUSD === String(usd) ? "" : String(usd))}
                    className={cn(
                      "flex-1 flex flex-col items-center py-2 rounded-lg text-xs transition-all",
                      ownershipUSD === String(usd)
                        ? "bg-gray-800 text-white"
                        : "bg-gray-100 hover:bg-gray-200 text-gray-600"
                    )}
                  >
                    <span className="font-semibold">{pct}%</span>
                    <span className="text-[10px] opacity-70">${usd}</span>
                  </button>
                ))}
              </div>
            </div>
          );
        })()}

        {/* Launch summary */}
        <div className="bg-white rounded-xl p-3 space-y-1.5 text-xs">
          {[
            { label: "Supply", value: "10,000,000 (fixed)", icon: Shield },
            { label: "Graduation", value: `${GRADUATION_SOL} SOL`, icon: Zap },
            { label: "Creator Royalty", value: `${CREATOR_FEE_BPS / 100}% forever`, icon: BadgeDollarSign },
            { label: "Mint Authority", value: "Revoked at graduation", icon: Lock },
          ].map(({ label, value, icon: Icon }) => (
            <div key={label} className="flex items-center gap-2">
              <Icon size={12} className="text-gray-400" />
              <span className="text-gray-400 flex-1">{label}</span>
              <span className="font-medium text-gray-700">{value}</span>
            </div>
          ))}
        </div>

        {/* Launch button */}
        {connected ? (
          <button
            onClick={handleLaunch}
            disabled={loading}
            className="glass-trade-btn"
          >
            {loading ? (
              <span className="flex items-center justify-center gap-2">
                <Zap size={14} className="animate-pulse" /> Launching on Solana...
              </span>
            ) : (
              "Launch Token"
            )}
          </button>
        ) : (
          <div className="flex justify-center">
            <WalletMultiButton />
          </div>
        )}

      </div>
    </div>
  );
}
