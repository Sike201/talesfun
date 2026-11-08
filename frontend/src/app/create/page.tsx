"use client";

import { useState, useRef, useEffect } from "react";
import { useRouter } from "next/navigation";
import { useWallet, useConnection } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import {
  Upload, Bird, Send, Globe, Zap, AlertCircle, ChevronDown,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { GRADUATION_SOL, FIXED_SUPPLY } from "@/types";
import toast from "react-hot-toast";
import Image from "next/image";
import type { AnchorProvider } from "@coral-xyz/anchor";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { useProgram } from "@/hooks/useProgram";
import {
  isTransientConfirmationFailure,
  sendRawTransactionWithPollingConfirm,
  signatureFromSignedLegacyTransaction,
} from "@/lib/txConfirmPoll";
import {
  getMetadataPDA,
  getMintAuthorityPDA,
  getSolVaultPDA,
  getTokenStatePDA,
  getPlatformPDA,
  getReadOnlyProgram,
} from "@/lib/program";
import LaunchPathJourney from "@/components/landing/LaunchPathJourney";
import CoinPreview from "@/components/landing/CoinPreview";
import { fraunces } from "@/lib/fonts";

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

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return String(error);
}

async function confirmTokenStateExists(
  connection: Connection,
  mint: PublicKey,
  maxAttempts = 6,
  delayMs = 500
): Promise<boolean> {
  const ro = getReadOnlyProgram(connection);
  const [pda] = getTokenStatePDA(mint);
  for (let i = 0; i < maxAttempts; i++) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (ro.account as any).tokenState.fetch(pda);
      return true;
    } catch {
      if (i < maxAttempts - 1) await new Promise(r => setTimeout(r, delayMs));
    }
  }
  return false;
}

export default function CreatePage() {
  useEffect(() => {
    console.log("[higher.run] FRONTEND create page loaded");
  }, []);

  const router = useRouter();
  const { connected, publicKey } = useWallet();
  const { connection } = useConnection();
  const program = useProgram();
  const [isLaunching, setIsLaunching] = useState(false);
  const [launchStep, setLaunchStep] = useState<"idle" | "launching" | "submitted">("idle");
  const [ownershipUSD, setOwnershipUSD] = useState("");
  const [showMore, setShowMore] = useState(false);
  const [platformReady, setPlatformReady] = useState<boolean | null>(null);
  const [initializingPlatform, setInitializingPlatform] = useState(false);
  /** Rent-exempt minimum for the 0-byte `sol_vault` PDA (not tradable curve liquidity). */
  const [solVaultRentSol, setSolVaultRentSol] = useState<string | null>(null);
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

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const lamports = await connection.getMinimumBalanceForRentExemption(0);
        if (!cancelled) {
          setSolVaultRentSol((lamports / LAMPORTS_PER_SOL).toFixed(4));
        }
      } catch {
        if (!cancelled) setSolVaultRentSol(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [connection]);

  const prevWalletKeyRef = useRef<string | null>(null);
  useEffect(() => {
    const next = publicKey?.toBase58() ?? null;
    const prev = prevWalletKeyRef.current;
    prevWalletKeyRef.current = next;
    if (prev === next) return;
    console.log("[wallet] switch", {
      component: "create",
      prev,
      next,
      reset: "isLaunching+launchStep",
    });
    setIsLaunching(false);
    setLaunchStep("idle");
  }, [publicKey?.toBase58()]);

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
    if (isLaunching) return;
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

    setIsLaunching(true);
    setLaunchStep("launching");
    let mintPubkey: PublicKey | null = null;
    /** Hoisted for outer `catch` recovery when the tx lands but a later step throws. */
    let metadataUri = "";
    let imageUrl = "";
    let feeRecipientForPersist: PublicKey | null = null;

    const persistLaunchedTokenToApi = async (
      mintPk: PublicKey,
      recipient: PublicKey,
      metaUri: string,
      imgUrl: string
    ) => {
      const totalSupplyRaw = FIXED_SUPPLY * 1_000_000;
      const persistPayload = {
        mint: mintPk.toBase58(),
        creator: publicKey!.toBase58(),
        creator_fee_recipient: recipient.toBase58(),
        name: form.name.trim(),
        symbol: form.ticker.trim(),
        uri: metaUri || null,
        image_url: imgUrl || null,
        description: form.description.trim(),
        about: form.description.trim(),
        twitter: form.twitter.trim() || null,
        telegram: form.telegram.trim() || null,
        website: form.website.trim() || null,
        phase: "bonding" as const,
        total_supply: totalSupplyRaw,
      };
      console.log("[higher.run] FRONTEND token persist payload:", JSON.stringify(persistPayload));
      console.log("[higher.run] FRONTEND ABOUT TO POST /api/tokens");
      try {
        const persistRes = await fetch("/api/tokens", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(persistPayload),
        });
        const persistJson = await persistRes.json().catch(() => ({}));
        console.log("[higher.run] FRONTEND token persist response:", persistRes.status, persistJson);
        if (!persistRes.ok) {
          toast.error(
            typeof (persistJson as { error?: string }).error === "string"
              ? `Could not save token to database: ${(persistJson as { error: string }).error.slice(0, 80)}`
              : "Could not save token to database — trades may fail until this is fixed"
          );
        }
      } catch (e) {
        console.error("[higher.run] FRONTEND token persist request failed:", e);
        toast.error("Could not reach server to save token metadata");
      }
    };

    const finishSuccess = async (mint: PublicKey) => {
      setLaunchStep("submitted");
      const exists = await confirmTokenStateExists(connection, mint);
      if (!exists) {
        toast.error("Transaction may have succeeded but the token account was not found yet. Check the explorer or try again in a moment.");
        return;
      }
      toast.success("Token launched");
      router.push(`/token/${mint.toBase58()}`);
    };

    try {
      // 1. Upload metadata JSON to Pinata (image optional)
      {
        console.log("[higher.run] Uploading metadata to Pinata...");
        const uploadData = new FormData();
        uploadData.append("name", form.name);
        uploadData.append("symbol", form.ticker);
        uploadData.append("description", form.description);
        if (form.image) uploadData.append("image", form.image);
        if (form.twitter) uploadData.append("twitter", form.twitter);
        if (form.telegram) uploadData.append("telegram", form.telegram);
        if (form.website) uploadData.append("website", form.website);

        const uploadRes = await fetch("/api/upload", { method: "POST", body: uploadData });
        if (!uploadRes.ok) {
          const errBody = await uploadRes.json().catch(() => ({}));
          const detail =
            typeof errBody.details === "string"
              ? errBody.details
              : typeof errBody.error === "string"
                ? errBody.error
                : "Upload failed";
          throw new Error(detail);
        }
        const uploadJson = (await uploadRes.json()) as {
          uri?: string;
          imageUri?: string | null;
        };
        metadataUri = uploadJson.uri ?? "";
        imageUrl = uploadJson.imageUri ?? "";
        console.log("[higher.run] Metadata URI:", metadataUri);
      }

      // 2. Generate mint keypair and derive all PDAs
      const mintKeypair = Keypair.generate();
      const mint = mintKeypair.publicKey;
      mintPubkey = mint;

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
        catch {
          toast.error("Invalid fee recipient address");
          return;
        }
      }
      feeRecipientForPersist = feeRecipient;

      // 4. createToken — send + confirm via HTTP polling (avoid WS-only confirmTransaction timeouts)
      const provider = program.provider as AnchorProvider;
      const preflightCommitment =
        provider.opts.preflightCommitment ?? ("confirmed" as const);

      console.log("[create] build createToken transaction");
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
        .transaction();

      tx.feePayer = publicKey;
      const { blockhash } = await connection.getLatestBlockhash(preflightCommitment);
      tx.recentBlockhash = blockhash;
      tx.partialSign(mintKeypair);

      console.log("[create] wallet signing createToken…");
      const signedTx = await provider.wallet.signTransaction(tx);
      const sigPreview = signatureFromSignedLegacyTransaction(signedTx);
      console.log("[create] wallet signed; tx signature", sigPreview ?? "(none)");

      const raw = signedTx.serialize();
      console.log("[create] broadcast + confirm: polling signature status (not websocket-only)");

      let createSig: string;
      try {
        createSig = await sendRawTransactionWithPollingConfirm(
          connection,
          raw,
          signedTx
        );
      } catch (sendPollErr) {
        console.warn("[create] send/poll path error", sendPollErr);
        if (mintPubkey && isTransientConfirmationFailure(sendPollErr)) {
          console.log(
            "[create] fallback: possible flaky confirmation — verifying token_state for mint",
            mintPubkey.toBase58()
          );
          const exists = await confirmTokenStateExists(
            connection,
            mintPubkey,
            90,
            500
          );
          if (exists) {
            console.log(
              "[create] final decision: SUCCESS (token_state found after transient error)"
            );
            await persistLaunchedTokenToApi(
              mintPubkey,
              feeRecipient,
              metadataUri,
              imageUrl
            );
            await finishSuccess(mintPubkey);
            return;
          }
          console.warn(
            "[create] final decision: FAILURE (token_state missing after fallback wait)"
          );
        }
        throw sendPollErr;
      }

      console.log("[create] final decision: SUCCESS (polled confirmation)", createSig);

      await persistLaunchedTokenToApi(mint, feeRecipient, metadataUri, imageUrl);

      await finishSuccess(mint);
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

      if (
        mintPubkey &&
        feeRecipientForPersist &&
        isTransientConfirmationFailure(error)
      ) {
        console.log(
          "[create] outer catch: transient RPC/confirm noise — verifying token_state"
        );
        const exists = await confirmTokenStateExists(
          connection,
          mintPubkey,
          50,
          400
        );
        if (exists) {
          console.log(
            "[create] final decision: SUCCESS (token_state found in outer catch)"
          );
          try {
            await persistLaunchedTokenToApi(
              mintPubkey,
              feeRecipientForPersist,
              metadataUri,
              imageUrl
            );
          } catch (persistErr) {
            console.warn("[create] persist after recovery failed (non-fatal)", persistErr);
          }
          await finishSuccess(mintPubkey);
          return;
        }
      }

      const display = getErrorMessage(error);
      const shortened = display.length > 120 ? display.slice(0, 120) + "..." : display;
      toast.error(shortened);
    } finally {
      setIsLaunching(false);
      setLaunchStep("idle");
    }
  };

  const fieldClass =
    "w-full rounded-xl bg-white/[0.06] px-3 py-2.5 text-sm text-white placeholder:text-white/30 focus:outline-none focus:ring-1 focus:ring-white/20";
  const labelClass =
    "mb-1.5 block text-xs font-semibold uppercase tracking-wider text-white/40";

  return (
    <div data-tales-page>
      <div className="mx-auto max-w-6xl px-6 pb-24 pt-8">
        <div className="mb-6">
          <LaunchPathJourney compact />
        </div>

        <div className="mb-6 max-w-xl">
          <h1
            className={cn(fraunces.className, "font-fraunces text-[2rem] font-medium tracking-[-0.03em] text-white sm:text-[2.25rem]")}
            style={{
              fontFamily:
                "var(--font-fraunces), Fraunces, ui-serif, Georgia, serif",
              fontVariationSettings: '"SOFT" 55, "WONK" 1, "opsz" 144',
            }}
          >
            Create new coin
          </h1>
          <p className="mt-2 text-sm text-white/50">
            Choose carefully — name, ticker, and image can&apos;t be changed after
            launch.
          </p>
        </div>

        <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(16rem,20rem)] lg:items-start">
          <div className="space-y-5 rounded-2xl bg-white/[0.035] p-6">
            <div>
              <label className={labelClass}>Image</label>
              <div
                onClick={() => fileInputRef.current?.click()}
                className={cn(
                  "cursor-pointer rounded-xl border border-dashed p-5 text-center transition-colors",
                  form.imagePreview
                    ? "border-white/20 bg-white/[0.04]"
                    : "border-white/15 hover:border-white/25 hover:bg-white/[0.03]"
                )}
              >
                {form.imagePreview ? (
                  <div className="flex items-center justify-center gap-3">
                    <div className="relative h-14 w-14 overflow-hidden rounded-xl">
                      <Image
                        src={form.imagePreview}
                        alt="preview"
                        fill
                        className="object-cover"
                      />
                    </div>
                    <div className="text-left">
                      <p className="text-sm font-medium text-white/80">
                        {form.image?.name}
                      </p>
                      <p className="text-[10px] text-white/35">Click to change</p>
                    </div>
                  </div>
                ) : (
                  <div>
                    <Upload size={20} className="mx-auto mb-1.5 text-white/30" />
                    <p className="text-sm text-white/55">
                      Select image or drag and drop
                    </p>
                    <p className="mt-1 text-[10px] text-white/35">
                      PNG, JPG, GIF · Max 5MB
                    </p>
                  </div>
                )}
              </div>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                onChange={handleImageUpload}
                className="hidden"
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className={labelClass}>Name</label>
                <input
                  type="text"
                  value={form.name}
                  onChange={e => set("name", e.target.value)}
                  placeholder="Name your coin"
                  className={fieldClass}
                />
              </div>
              <div>
                <label className={labelClass}>Ticker</label>
                <div className="relative">
                  <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm font-semibold text-white/30">
                    $
                  </span>
                  <input
                    type="text"
                    value={form.ticker}
                    onChange={e =>
                      set(
                        "ticker",
                        e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "")
                      )
                    }
                    placeholder="TICKER"
                    maxLength={10}
                    className={cn(fieldClass, "pl-7 font-semibold")}
                  />
                </div>
              </div>
            </div>

            <div>
              <label className={labelClass}>Description (optional)</label>
              <textarea
                value={form.description}
                onChange={e => set("description", e.target.value)}
                placeholder="Write a short description"
                rows={3}
                maxLength={500}
                className={cn(fieldClass, "resize-none")}
              />
            </div>

            <div className="space-y-3">
              <label className={labelClass}>Socials (optional)</label>
              {[
                { key: "website" as const, icon: Globe, placeholder: "Website URL" },
                { key: "twitter" as const, icon: Bird, placeholder: "X / Twitter" },
                { key: "telegram" as const, icon: Send, placeholder: "Telegram" },
              ].map(({ key, icon: Icon, placeholder }) => (
                <div key={key} className="relative">
                  <Icon
                    size={14}
                    className="absolute left-3 top-1/2 -translate-y-1/2 text-white/35"
                  />
                  <input
                    type="text"
                    value={form[key]}
                    onChange={e => set(key, e.target.value)}
                    placeholder={placeholder}
                    className={cn(fieldClass, "pl-9")}
                  />
                </div>
              ))}
            </div>

            <button
              type="button"
              onClick={() => setShowMore(v => !v)}
              className="flex w-full items-center justify-between rounded-xl bg-white/[0.04] px-3 py-2.5 text-left text-sm text-white/65 transition hover:bg-white/[0.06]"
            >
              <span>More options</span>
              <ChevronDown
                size={16}
                className={cn(
                  "text-white/40 transition-transform",
                  showMore && "rotate-180"
                )}
              />
            </button>

            {showMore ? (
              <div className="space-y-4 rounded-xl bg-white/[0.03] p-4">
                <div>
                  <label className={labelClass}>
                    Fee recipient{" "}
                    <span className="font-normal normal-case text-white/30">
                      defaults to your wallet
                    </span>
                  </label>
                  <input
                    type="text"
                    value={form.creatorFeeRecipient}
                    onChange={e => set("creatorFeeRecipient", e.target.value)}
                    placeholder={publicKey?.toBase58() || "Wallet address…"}
                    className={cn(fieldClass, "font-mono")}
                  />
                </div>

                {(() => {
                  const SOL_PRICE = 140;
                  const LAUNCH_PRICE_SOL = 0.0000038;
                  const PRESETS = [
                    { pct: 1, tokens: 100_000 },
                    { pct: 10, tokens: 1_000_000 },
                    { pct: 30, tokens: 3_000_000 },
                  ].map(p => ({
                    ...p,
                    usd: Math.round(p.tokens * LAUNCH_PRICE_SOL * SOL_PRICE),
                  }));
                  const usdNum = parseFloat(ownershipUSD) || 0;
                  const solEquiv =
                    usdNum > 0 ? (usdNum / SOL_PRICE).toFixed(4) : null;

                  return (
                    <div>
                      <label className={cn(labelClass, "mb-0.5")}>
                        Dev buy (optional)
                      </label>
                      <p className="mb-2 text-xs text-white/40">
                        Buy before anyone else.
                      </p>
                      <div className="mb-2 flex items-center gap-1 rounded-xl bg-white/[0.06] px-3 py-2.5">
                        <span className="text-base font-semibold text-white/30">
                          $
                        </span>
                        <input
                          type="number"
                          value={ownershipUSD}
                          onChange={e => setOwnershipUSD(e.target.value)}
                          placeholder="0.00"
                          className="flex-1 bg-transparent text-base font-semibold text-white placeholder:text-white/30 focus:outline-none"
                        />
                      </div>
                      <p className="mb-2 text-xs text-white/40">
                        {solEquiv ? `≈ ${solEquiv} SOL` : "≈ 0 SOL"}
                      </p>
                      <div className="flex gap-1.5">
                        {PRESETS.map(({ pct, usd }) => (
                          <button
                            key={pct}
                            type="button"
                            onClick={() =>
                              setOwnershipUSD(
                                ownershipUSD === String(usd) ? "" : String(usd)
                              )
                            }
                            className={cn(
                              "flex flex-1 flex-col items-center rounded-lg py-2 text-xs transition-all",
                              ownershipUSD === String(usd)
                                ? "bg-white text-black"
                                : "bg-white/[0.06] text-white/60 hover:bg-white/10"
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

                <p className="text-[11px] leading-relaxed text-white/40">
                  Launch pays a one-time vault rent
                  {solVaultRentSol != null
                    ? ` (~${solVaultRentSol} SOL)`
                    : ""}
                  . Not curve liquidity. Graduates at {GRADUATION_SOL} SOL.
                </p>
              </div>
            ) : null}

            {connected && platformReady === false && (
              <div className="space-y-2 rounded-xl bg-amber-500/10 p-4">
                <div className="flex items-center gap-2 text-xs font-semibold text-amber-300">
                  <AlertCircle size={14} /> Platform not initialized
                </div>
                <p className="text-xs text-amber-200/80">
                  The on-chain platform account must be created once before any
                  tokens can launch.
                </p>
                <button
                  onClick={handleInitializePlatform}
                  disabled={initializingPlatform}
                  className="w-full rounded-xl bg-amber-400 py-2.5 text-sm font-semibold text-black transition-colors hover:bg-amber-300 disabled:opacity-50"
                >
                  {initializingPlatform ? "Initializing..." : "Initialize Platform"}
                </button>
              </div>
            )}

            {connected ? (
              <button
                onClick={handleLaunch}
                disabled={isLaunching || platformReady === false}
                className="home-btn-primary w-full disabled:opacity-50"
                style={{ border: "none", cursor: "pointer" }}
              >
                {isLaunching ? (
                  <span className="flex items-center justify-center gap-2">
                    <Zap size={14} className="animate-pulse" />
                    {launchStep === "submitted"
                      ? "Transaction submitted..."
                      : "Launching on Solana..."}
                  </span>
                ) : (
                  "Launch coin"
                )}
              </button>
            ) : (
              <div className="flex flex-col items-center gap-2 pt-1">
                <p className="text-xs text-white/40">
                  Connect your wallet to launch
                </p>
                <WalletMultiButton />
              </div>
            )}
          </div>

          <CoinPreview
            name={form.name}
            ticker={form.ticker}
            description={form.description}
            imagePreview={form.imagePreview}
          />
        </div>
      </div>
    </div>
  );
}
