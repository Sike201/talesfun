"use client";

import { useState, useRef, useEffect } from "react";
import { useWallet, useConnection } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import {
  Upload, Bird, Send, Globe, Zap, Shield, BadgeDollarSign,
  AlertCircle, CheckCircle2, ArrowRight, Info, Lock
} from "lucide-react";
import { cn } from "@/lib/utils";
import { GRADUATION_SOL, CREATOR_FEE_BPS } from "@/types";
import toast from "react-hot-toast";
import Image from "next/image";
import { Keypair, PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { useProgram } from "@/hooks/useProgram";
import {
  getMetadataPDA,
  getMintAuthorityPDA,
  getSolVaultPDA,
  getTokenStatePDA,
  getPlatformPDA,
} from "@/lib/program";

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
  const { connected, publicKey } = useWallet();
  const { connection } = useConnection();
  const program = useProgram();
  const [loading, setLoading] = useState(false);
  const [launched, setLaunched] = useState(false);
  const [launchedMint, setLaunchedMint] = useState("");
  const [ownershipUSD, setOwnershipUSD] = useState("");
  const [platformReady, setPlatformReady] = useState<boolean | null>(null);
  const [initializingPlatform, setInitializingPlatform] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [form, setForm] = useState<FormData>({
    name: "", ticker: "", description: "", image: null, imagePreview: "",
    twitter: "", telegram: "", website: "", creatorFeeRecipient: "",
  });

  // Check if the on-chain platform PDA is initialized
  useEffect(() => {
    async function checkPlatform() {
      try {
        const [pda] = getPlatformPDA();
        const info = await connection.getAccountInfo(pda);
        setPlatformReady(info !== null);
        if (info) {
          console.log("[higher.run] Platform PDA found:", pda.toBase58());
        } else {
          console.warn("[higher.run] Platform PDA not initialized yet:", pda.toBase58());
        }
      } catch {
        setPlatformReady(false);
      }
    }
    checkPlatform();
  }, [connection]);

  // Log wallet connection state
  useEffect(() => {
    if (connected && publicKey) {
      console.log("[higher.run] Wallet connected:", publicKey.toBase58());
    } else {
      console.log("[higher.run] Wallet not connected");
    }
  }, [connected, publicKey]);

  const handleInitializePlatform = async () => {
    if (!program || !publicKey) return;
    setInitializingPlatform(true);
    try {
      console.log("[higher.run] Calling initializePlatform...");
      console.log("[higher.run] Authority (your wallet):", publicKey.toBase58());
      const tx = await program.methods
        .initializePlatform(publicKey) // fee recipient = your wallet for now
        .accountsPartial({})
        .rpc();
      console.log("[higher.run] initializePlatform TX:", tx);
      toast.success(`Platform initialized! TX: ${tx.slice(0, 8)}...`);
      setPlatformReady(true);
    } catch (error) {
      console.error("[higher.run] initializePlatform failed:", error);
      toast.error(error instanceof Error ? error.message : "Platform initialization failed");
    } finally {
      setInitializingPlatform(false);
    }
  };

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
    if (!connected || !publicKey || !program) {
      toast.error("Connect your wallet first");
      return;
    }
    if (!platformReady) {
      toast.error("Platform not initialized — click 'Initialize Platform' first");
      return;
    }
    const err = validate();
    if (err) { toast.error(err); return; }

    setLoading(true);
    try {
      // 1. Upload image + metadata to Pinata (if image provided)
      let metadataUri = "";
      if (form.image) {
        console.log("[higher.run] Uploading image to Pinata...");
        const uploadData = new FormData();
        uploadData.append("image", form.image);
        uploadData.append("name", form.name);
        uploadData.append("symbol", form.ticker);
        uploadData.append("description", form.description);
        if (form.twitter) uploadData.append("twitter", form.twitter);
        if (form.telegram) uploadData.append("telegram", form.telegram);
        if (form.website) uploadData.append("website", form.website);

        const uploadRes = await fetch("/api/upload", { method: "POST", body: uploadData });
        if (!uploadRes.ok) throw new Error("Image upload failed");
        const { uri } = await uploadRes.json();
        metadataUri = uri;
        console.log("[higher.run] Metadata URI:", metadataUri);
      }

      // 2. Generate mint keypair and derive all PDAs
      const mintKeypair = Keypair.generate();
      const mint = mintKeypair.publicKey;

      const [tokenStatePDA] = getTokenStatePDA(mint);
      const [mintAuthorityPDA] = getMintAuthorityPDA(mint);
      const [solVaultPDA] = getSolVaultPDA(mint);
      const [platformPDA] = getPlatformPDA();
      const metadataPDA = getMetadataPDA(mint);
      // ATA owned by sol_vault PDA (allowOwnerOffCurve = true because sol_vault is a PDA)
      const tokenVaultATA = getAssociatedTokenAddressSync(mint, solVaultPDA, true);

      console.log("[higher.run] === createToken accounts ===");
      console.log("[higher.run]   creator        :", publicKey.toBase58());
      console.log("[higher.run]   mint            :", mint.toBase58());
      console.log("[higher.run]   token_state PDA :", tokenStatePDA.toBase58());
      console.log("[higher.run]   mint_authority  :", mintAuthorityPDA.toBase58());
      console.log("[higher.run]   sol_vault PDA   :", solVaultPDA.toBase58());
      console.log("[higher.run]   token_vault ATA :", tokenVaultATA.toBase58());
      console.log("[higher.run]   metadata PDA    :", metadataPDA.toBase58());
      console.log("[higher.run]   platform PDA    :", platformPDA.toBase58());

      // 3. Determine fee recipient
      let feeRecipient = publicKey;
      if (form.creatorFeeRecipient) {
        try { feeRecipient = new PublicKey(form.creatorFeeRecipient); }
        catch { toast.error("Invalid fee recipient address"); setLoading(false); return; }
      }

      // 4. Call the on-chain createToken instruction
      console.log("[higher.run] Sending createToken — Phantom should prompt to sign...");
      const tx = await program.methods
        .createToken({
          name: form.name,
          symbol: form.ticker,
          uri: metadataUri,
          creatorFeeRecipient: feeRecipient,
        })
        .accountsPartial({
          mint,
          mintAuthority: mintAuthorityPDA,
          solVault: solVaultPDA,
          tokenVault: tokenVaultATA,
          tokenState: tokenStatePDA,
          metadata: metadataPDA,
          platform: platformPDA,
          creator: publicKey,
        })
        .signers([mintKeypair])
        .rpc();

      console.log("[higher.run] createToken TX confirmed:", tx);
      toast.success(`Token created! TX: ${tx.slice(0, 8)}...`);
      setLaunchedMint(mintKeypair.publicKey.toBase58());
      setLaunched(true);
    } catch (error) {
      console.error("[higher.run] Launch failed:", error);
      if (
        error !== null &&
        typeof error === "object" &&
        "getLogs" in error &&
        typeof (error as { getLogs: unknown }).getLogs === "function"
      ) {
        try {
          const logs = await (error as { getLogs: () => Promise<string[] | null> }).getLogs();
          console.error("[higher.run] Launch logs:", logs);
        } catch {
          // getLogs itself failed — ignore
        }
      }
      const msg = error instanceof Error ? error.message : "Launch failed";
      toast.error(msg.length > 120 ? msg.slice(0, 120) + "..." : msg);
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
        <p className="text-sm text-gray-400 mt-1">1B fixed supply · Anti-rug · Perpetual royalties</p>
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
            { label: "Supply", value: "1,000,000,000 (fixed)", icon: Shield },
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

        {/* Platform init banner (one-time setup) */}
        {connected && platformReady === false && (
          <div className="bg-yellow-50 border border-yellow-200 rounded-xl p-4 space-y-2">
            <div className="flex items-center gap-2 text-yellow-700 text-xs font-semibold">
              <AlertCircle size={14} /> Platform not initialized
            </div>
            <p className="text-xs text-yellow-600">
              The on-chain platform account must be created once before any tokens can launch.
            </p>
            <button
              onClick={handleInitializePlatform}
              disabled={initializingPlatform}
              className="w-full py-2.5 rounded-xl text-sm font-semibold bg-yellow-500 hover:bg-yellow-600 text-white disabled:opacity-50 transition-colors"
            >
              {initializingPlatform ? "Initializing..." : "Initialize Platform"}
            </button>
          </div>
        )}

        {/* Launch button */}
        {connected ? (
          <button
            onClick={handleLaunch}
            disabled={loading || platformReady === false}
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
          <div className="flex flex-col items-center gap-2">
            <p className="text-xs text-gray-400">Connect your wallet to launch</p>
            <WalletMultiButton />
          </div>
        )}

      </div>
    </div>
  );
}
