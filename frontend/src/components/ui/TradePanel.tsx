"use client";

import { useState, useRef, useEffect, useMemo } from "react";
import { useWallet, useConnection } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { ArrowDownUp } from "lucide-react";
import { PublicKey, SystemProgram, type Connection } from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { BN } from "@coral-xyz/anchor";
import { Token, CREATOR_FEE_BPS } from "@/types";
import { cn, priceSolFromRaw } from "@/lib/utils";
import { useProgram } from "@/hooks/useProgram";
import { useWalletBalances } from "@/hooks/useWalletBalances";
import {
  PROGRAM_ID,
  getTokenStatePDA,
  getSolVaultPDA,
  getFeeEscrowPDA,
  getMintAuthorityPDA,
  getPlatformPDA,
  calculateTokensOut,
  calculateSolOut,
} from "@/lib/program";
import {
  persistLaunchpadTrade,
  type LaunchpadTradePayload,
} from "@/lib/persistLaunchpadTrade";
import { useSolUsd } from "@/hooks/useSolUsd";
import { requestTokenPhaseSync } from "@/lib/requestTokenPhaseSync";
import {
  lamportsFromSolUiSafe,
  logBondingQuoteDebug,
  maxBuyGrossLamportsWithinInventory,
  quoteBondingBuy,
  quoteBondingSellSolUi,
} from "@/lib/bondingCurveQuote";
import toast from "react-hot-toast";

type TradePersistBase = Omit<LaunchpadTradePayload, "signature" | "timestamp">;

/** Poll until signature reaches confirmed/finalized (or chain reports err). */
async function confirmTradeSignature(
  connection: Connection,
  signature: string,
  timeoutMs = 90_000
): Promise<{ status: string }> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const { value } = await connection.getSignatureStatuses([signature], {
      searchTransactionHistory: true,
    });
    const st = value[0];
    if (st == null) {
      await new Promise(r => setTimeout(r, 400));
      continue;
    }
    if (st.err) {
      throw new Error(`On-chain failure: ${JSON.stringify(st.err)}`);
    }
    const c = st.confirmationStatus;
    if (c === "confirmed" || c === "finalized") {
      return { status: c };
    }
    await new Promise(r => setTimeout(r, 400));
  }
  throw new Error("Confirmation timeout");
}

/** Collect message text from Error chains and common wallet/Anchor shapes. */
function collectErrorText(error: unknown): string {
  const parts: string[] = [];
  const visit = (e: unknown, depth: number) => {
    if (depth > 6 || e == null) return;
    if (typeof e === "string") {
      parts.push(e);
      return;
    }
    if (e instanceof Error) {
      parts.push(e.message);
      if (e.cause != null) visit(e.cause, depth + 1);
      return;
    }
    if (typeof e === "object") {
      const o = e as Record<string, unknown>;
      if (typeof o.message === "string") parts.push(o.message);
      if (typeof o.msg === "string") parts.push(o.msg);
      if (o.cause != null) visit(o.cause, depth + 1);
    }
  };
  visit(error, 0);
  return parts.join(" ");
}

function isLikelyTxSignature(s: string): boolean {
  return /^[1-9A-HJ-NP-Za-km-z]{80,100}$/.test(s);
}

/** Walk Anchor / wallet error trees for embedded base58 signatures. */
function findSignatureDeep(err: unknown, depth: number): string | null {
  if (depth > 10 || err == null) return null;
  if (typeof err === "string") {
    const txM = err.match(/Transaction\s+([1-9A-HJ-NP-Za-km-z]{64,128})\s+resulted/i);
    if (txM?.[1] && isLikelyTxSignature(txM[1])) return txM[1];
    const m = err.match(/\b([1-9A-HJ-NP-Za-km-z]{80,100})\b/);
    if (m?.[1]) return m[1];
    return null;
  }
  if (err instanceof Error) {
    return (
      findSignatureDeep(err.message, depth + 1) ??
      (err.cause != null ? findSignatureDeep(err.cause, depth + 1) : null) ??
      findSignatureDeep(err as object, depth + 1)
    );
  }
  if (Array.isArray(err)) {
    for (const x of err) {
      const f = findSignatureDeep(x, depth + 1);
      if (f) return f;
    }
    return null;
  }
  if (typeof err === "object") {
    const o = err as Record<string, unknown>;
    for (const key of [
      "signature",
      "transactionSignature",
      "txSignature",
      "txid",
    ]) {
      const v = o[key];
      if (typeof v === "string" && isLikelyTxSignature(v)) return v;
    }
    for (const v of Object.values(o)) {
      const f = findSignatureDeep(v, depth + 1);
      if (f) return f;
    }
  }
  return null;
}

/**
 * Signature for duplicate-tx errors: `SendTransactionError` embeds it in
 * `Transaction <sig> resulted…` (regex \b can miss); Anchor may nest it without that text.
 */
function extractSignatureFromError(error: unknown): string | null {
  const text = collectErrorText(error);
  const txM = text.match(/Transaction\s+([1-9A-HJ-NP-Za-km-z]{64,128})\s+resulted/i);
  if (txM?.[1] && isLikelyTxSignature(txM[1])) return txM[1];
  const m = text.match(/\b([1-9A-HJ-NP-Za-km-z]{80,100})\b/);
  if (m?.[1]) return m[1];
  return findSignatureDeep(error, 0);
}

/** When the RPC/wallet error omits the sig, take the newest signer tx that touches program + mint. */
async function findRecentBondingTradeSignature(
  connection: Connection,
  signer: PublicKey,
  mintBase58: string
): Promise<string | null> {
  const pid = PROGRAM_ID.toBase58();
  const recent = await connection.getSignaturesForAddress(signer, { limit: 15 });
  for (const row of recent) {
    if (row.err) continue;
    try {
      const tx = await connection.getTransaction(row.signature, {
        maxSupportedTransactionVersion: 0,
      });
      const logs = tx?.meta?.logMessages?.join("\n") ?? "";
      if (!logs.includes(pid)) continue;
      const tokenBal = [
        ...(tx?.meta?.preTokenBalances ?? []),
        ...(tx?.meta?.postTokenBalances ?? []),
      ];
      if (tokenBal.some(b => b.mint === mintBase58)) return row.signature;
      const blob = JSON.stringify(tx?.transaction);
      if (blob.includes(mintBase58)) return row.signature;
    } catch {
      continue;
    }
  }
  return null;
}

function isAlreadyProcessedError(error: unknown): boolean {
  const m = collectErrorText(error).toLowerCase();
  return (
    m.includes("this transaction has already been processed") ||
    m.includes("already been processed") ||
    m.includes("transaction has already been processed") ||
    m.includes("already processed")
  );
}

/** Anchor `LaunchpadError::InsufficientLiquidity` (6006) — used for pool depth and vault rent floor. */
function isInsufficientLiquidityError(error: unknown): boolean {
  const t = collectErrorText(error);
  const lower = t.toLowerCase();
  return (
    lower.includes("insufficientliquidity") ||
    lower.includes("insufficient liquidity") ||
    /\b6006\b/.test(t) ||
    /error number:\s*6006/i.test(t)
  );
}

/** Matches launchpad mint (`TOKEN_DECIMALS` in program). */
const TOKEN_UI_DECIMALS = 6;

/** Smallest-units → plain decimal string for the sell amount input. */
function rawTokenToUiAmountString(portionRaw: bigint): string {
  const zero = BigInt(0);
  if (portionRaw <= zero) return "0";
  const scale = BigInt(10) ** BigInt(TOKEN_UI_DECIMALS);
  const whole = portionRaw / scale;
  const frac = portionRaw % scale;
  if (frac === zero) return whole.toString();
  const fracStr = frac.toString().padStart(TOKEN_UI_DECIMALS, "0").replace(/0+$/, "");
  return `${whole}.${fracStr}`;
}

/**
 * UI token string → raw integer units. Truncates fractional digits beyond `decimals` (no round-up).
 */
function uiTokenStringToRawTruncated(ui: string, decimals: number): bigint {
  const trimmed = ui.trim();
  const dot = trimmed.indexOf(".");
  const wholeStr = dot === -1 ? trimmed : trimmed.slice(0, dot);
  let fracStr = dot === -1 ? "" : trimmed.slice(dot + 1);
  if (wholeStr === "" && fracStr === "") throw new Error("empty");
  if (wholeStr !== "" && !/^\d+$/.test(wholeStr)) throw new Error("invalid");
  if (!/^\d*$/.test(fracStr)) throw new Error("invalid");
  const w = wholeStr === "" ? "0" : wholeStr.replace(/^0+/, "") || "0";
  if (fracStr.length > decimals) fracStr = fracStr.slice(0, decimals);
  else if (fracStr.length < decimals) fracStr = fracStr + "0".repeat(decimals - fracStr.length);
  const scale = BigInt(10) ** BigInt(decimals);
  return BigInt(w) * scale + BigInt(fracStr === "" ? "0" : fracStr);
}

async function logSendTransactionErrorLogs(error: unknown): Promise<void> {
  const msg = collectErrorText(error) || String(error);
  let printedLogs = false;
  if (
    error !== null &&
    typeof error === "object" &&
    "getLogs" in error &&
    typeof (error as { getLogs: unknown }).getLogs === "function"
  ) {
    try {
      const logs = await (error as { getLogs: () => Promise<string[] | null> }).getLogs();
      if (logs && logs.length > 0) {
        console.error("[higher.run] trade simulation logs:\n" + logs.join("\n"));
        printedLogs = true;
      }
    } catch {
      /* ignore */
    }
  }
  if (!printedLogs) {
    console.error("[higher.run] trade error (no simulation logs):", msg);
  }
}

interface Props {
  token: Token;
}

export default function TradePanel({ token }: Props) {
  const { solUsd: solUsdOracle } = useSolUsd();
  useEffect(() => {
    console.log("[higher.run] FRONTEND Trade component loaded (TradePanel — bonding curve)");
  }, []);

  const { connected, publicKey } = useWallet();
  const { connection } = useConnection();
  const program = useProgram();
  const { tokenBalanceRaw, refreshBalances } = useWalletBalances(token.mint);
  const [mode, setMode] = useState<"buy" | "sell">("buy");
  const [amount, setAmount] = useState("");
  /** idle → submitting (wallet/tx) → confirming (RPC poll) → syncing (balances + parent refresh) */
  const [tradePhase, setTradePhase] = useState<
    "idle" | "submitting" | "confirming" | "syncing"
  >("idle");
  const isTrading = tradePhase !== "idle";
  /** Synchronous guard — blocks double-submit before React re-renders. */
  const tradePendingRef = useRef(false);
  /** Last bonding persist payload (outer duplicate path may need to POST without inner success). */
  const pendingPersistRef = useRef<TradePersistBase | null>(null);

  const prevWalletKeyRef = useRef<string | null>(null);
  useEffect(() => {
    const next = publicKey?.toBase58() ?? null;
    const prev = prevWalletKeyRef.current;
    prevWalletKeyRef.current = next;
    if (prev === next) return;
    console.log("[wallet] switch", {
      component: "TradePanel",
      prev,
      next,
      reset: "tradePhase+tradePendingRef+pendingPersistRef+amount",
    });
    tradePendingRef.current = false;
    pendingPersistRef.current = null;
    setTradePhase("idle");
    setAmount("");
  }, [publicKey?.toBase58()]);

  /** Parsed SOL amount — only meaningful when `mode === "buy"` (sell tab uses token amounts in `amount`). */
  const buySolUi = useMemo(() => {
    if (mode !== "buy" || !amount?.trim()) return null;
    const n = parseFloat(amount);
    if (!Number.isFinite(n) || n <= 0) return null;
    if (lamportsFromSolUiSafe(n) == null) return null;
    return n;
  }, [mode, amount]);

  const bondingQuoteReady =
    token.phase === "bonding" &&
    !!token.chainVirtualSolLamports &&
    !!token.chainVirtualTokenReserveRaw &&
    !!token.chainRealTokenReserveRaw;

  const buyQuote = useMemo(() => {
    if (!bondingQuoteReady || mode !== "buy" || buySolUi == null) return null;
    return quoteBondingBuy(
      buySolUi,
      token.chainVirtualSolLamports!,
      token.chainVirtualTokenReserveRaw!,
      token.chainRealTokenReserveRaw!
    );
  }, [
    bondingQuoteReady,
    mode,
    buySolUi,
    token.chainVirtualSolLamports,
    token.chainVirtualTokenReserveRaw,
    token.chainRealTokenReserveRaw,
    token.phase,
  ]);

  const sellSolEstimateSol = useMemo(() => {
    if (
      mode !== "sell" ||
      !bondingQuoteReady ||
      !amount?.trim() ||
      token.chainRealSolReserveLamports == null
    ) {
      return null;
    }
    let rawBn: bigint;
    try {
      rawBn = uiTokenStringToRawTruncated(amount, TOKEN_UI_DECIMALS);
    } catch {
      return null;
    }
    if (rawBn <= BigInt(0)) return null;
    const q = quoteBondingSellSolUi(
      new BN(rawBn.toString()),
      token.chainVirtualSolLamports!,
      token.chainVirtualTokenReserveRaw!,
      token.chainRealSolReserveLamports
    );
    if (!q) return null;
    return Number(q.solOutRaw.toString()) / 1e9;
  }, [
    mode,
    amount,
    bondingQuoteReady,
    token.chainVirtualSolLamports,
    token.chainVirtualTokenReserveRaw,
    token.chainRealSolReserveLamports,
  ]);

  useEffect(() => {
    if (buyQuote && bondingQuoteReady) {
      logBondingQuoteDebug("TradePanel estimate", buyQuote, token, solUsdOracle);
    }
  }, [buyQuote, bondingQuoteReady, token, solUsdOracle]);

  const handleTrade = async () => {
    if (tradePendingRef.current || isTrading) {
      console.log("[higher.run] trade blocked (already pending)", { mode });
      return;
    }
    if (!connected || !program || !publicKey) {
      toast.error("Connect your wallet to trade");
      return;
    }
    if (!amount?.trim()) {
      toast.error("Enter an amount");
      return;
    }
    if (mode === "buy") {
      const n = parseFloat(amount);
      if (!Number.isFinite(n) || n <= 0 || lamportsFromSolUiSafe(n) == null) {
        toast.error("Enter a valid SOL amount");
        return;
      }
    }

    tradePendingRef.current = true;
    console.log("[higher.run] trade start", { action: mode });
    setTradePhase("submitting");
    try {
      /** Snapshot at execution start — persist payloads use this, not a stale closure later. */
      const walletForPersist = publicKey.toBase58();
      const mint = new PublicKey(token.mint);
      const [tokenState] = getTokenStatePDA(mint);
      const [solVault] = getSolVaultPDA(mint);
      const [feeEscrow] = getFeeEscrowPDA(mint);
      const [mintAuthority] = getMintAuthorityPDA(mint);
      const [platformPda] = getPlatformPDA();
      const tokenVault = getAssociatedTokenAddressSync(mint, solVault, true);
      const userTokenAccount = getAssociatedTokenAddressSync(mint, publicKey, false);

      const refreshAfterTrade = async () => {
        await refreshBalances();
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const ts = await (program.account as any).tokenState.fetch(tokenState);
          console.log("[higher.run] refreshed tokenState solRaised (raw):", ts.solRaised?.toString?.());
          requestTokenPhaseSync(mint.toBase58());
        } catch (e) {
          console.warn("[higher.run] tokenState refresh failed:", e);
        }
      };

      const executeAndFinalize = async (
        kind: "buy" | "sell",
        rpcCall: () => Promise<string>,
        persist: TradePersistBase | null
      ) => {
        setTradePhase("submitting");
        const recordTrade = async (sig: string, duplicatePath: boolean) => {
          if (!persist) return;
          console.log(
            "[trade-history] TradePanel persist mint:",
            persist.mint,
            "side:",
            kind
          );
          const full = {
            ...persist,
            signature: sig,
            timestamp: new Date().toISOString(),
          };
          if (duplicatePath) {
            console.log("[higher.run] DUPLICATE PATH ABOUT TO PERSIST TRADE", full);
          }
          if (kind === "sell" && !duplicatePath) {
            console.log("[higher.run] SELL ABOUT TO PERSIST TRADE (recordTrade)", full);
          }
          await persistLaunchpadTrade(full);
          if (typeof window !== "undefined") {
            window.dispatchEvent(
              new CustomEvent("higher:trade-complete", {
                detail: {
                  mint: full.mint,
                  timestamp: full.timestamp,
                  price_sol: full.price_sol,
                  sol_amount_raw: full.sol_amount_raw,
                },
              })
            );
          }
        };

        let signature: string;
        try {
          signature = await rpcCall();
        } catch (e) {
          if (isAlreadyProcessedError(e)) {
            console.log("[higher.run] duplicate / already-processed error treated as success", {
              action: kind,
              snippet: collectErrorText(e).slice(0, 200),
            });
            let maybeSig = extractSignatureFromError(e);
            if (!maybeSig && publicKey) {
              maybeSig = await findRecentBondingTradeSignature(
                connection,
                publicKey,
                mint.toBase58()
              );
              if (maybeSig) {
                console.log(
                  "[higher.run] duplicate path: signature from recent-tx scan",
                  maybeSig.slice(0, 12) + "…"
                );
              }
            } else if (maybeSig) {
              console.log("[higher.run] tx signature (from error):", maybeSig.slice(0, 12) + "…");
            }
            if (maybeSig) {
              try {
                setTradePhase("confirming");
                const conf = await confirmTradeSignature(connection, maybeSig);
                console.log("[higher.run] confirmation result (duplicate path):", conf);
                setTradePhase("syncing");
                await refreshAfterTrade();
                await recordTrade(maybeSig, true);
                const verb = kind === "buy" ? "Bought" : "Sold";
                toast.success(`${verb} ${token.ticker}! TX: ${maybeSig.slice(0, 8)}...`);
                setAmount("");
                return;
              } catch (dupErr) {
                console.warn("[higher.run] duplicate path confirm failed, refreshing anyway:", dupErr);
              }
            } else {
              console.warn(
                "[higher.run] duplicate path: could not resolve tx signature — trade row may be missing"
              );
            }
            setTradePhase("syncing");
            await refreshAfterTrade();
            if (maybeSig) await recordTrade(maybeSig, true);
            else if (typeof window !== "undefined") {
              window.dispatchEvent(
                new CustomEvent("higher:trade-complete", { detail: { mint: mint.toBase58() } })
              );
            }
            toast.success(
              `${kind === "buy" ? "Buy" : "Sell"} completed on-chain. Balances refreshed.`
            );
            setAmount("");
            return;
          }
          await logSendTransactionErrorLogs(e);
          throw e;
        }

        console.log("[higher.run] tx signature:", signature);
        setTradePhase("confirming");
        const confResult = await confirmTradeSignature(connection, signature);
        console.log("[higher.run] confirmation result:", confResult);
        setTradePhase("syncing");
        await refreshAfterTrade();
        await recordTrade(signature, false);
        const verb = kind === "buy" ? "Bought" : "Sold";
        toast.success(`${verb} ${token.ticker}! TX: ${signature.slice(0, 8)}...`);
        setAmount("");
      };

      console.log("[higher.run] trade accounts derived:", {
        mint: mint.toBase58(),
        tokenState: tokenState.toBase58(),
        solVault: solVault.toBase58(),
        tokenVault: tokenVault.toBase58(),
        feeEscrow: feeEscrow.toBase58(),
        userTokenAccount: userTokenAccount.toBase58(),
        user: publicKey.toBase58(),
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const platformRow = await (program.account as any).platformState.fetch(platformPda);
      const platformFeeRecipient = platformRow.feeRecipient as PublicKey;

      const tradeAccounts = {
        tokenState,
        mint,
        solVault,
        tokenVault,
        userTokenAccount,
        user: publicKey,
        feeEscrow,
        mintAuthority,
        platform: platformPda,
        platformFeeRecipient,
        gammPoolPlaceholder: PublicKey.default,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      };

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const onChain = await (program.account as any).tokenState.fetch(tokenState);
      const virtualSolReserve = new BN(onChain.virtualSolReserve.toString());
      const virtualTokenReserve = new BN(onChain.virtualTokenReserve.toString());

      if (mode === "buy") {
        const realTokRem = new BN(onChain.realTokenReserve.toString());
        const buyLamportsStr = lamportsFromSolUiSafe(parseFloat(amount));
        if (buyLamportsStr == null) {
          toast.error("Invalid SOL amount");
          tradePendingRef.current = false;
          setTradePhase("idle");
          return;
        }
        const solLamportsDesired = new BN(buyLamportsStr);
        const solLamports = maxBuyGrossLamportsWithinInventory(
          solLamportsDesired,
          virtualSolReserve,
          virtualTokenReserve,
          realTokRem
        );
        if (solLamports.lte(new BN(0))) {
          toast.error("No tokens available on this bonding curve");
          tradePendingRef.current = false;
          setTradePhase("idle");
          return;
        }
        if (solLamports.lt(solLamportsDesired)) {
          toast(
            `Buy capped at ${(solLamports.toNumber() / 1e9).toFixed(4)} SOL (remaining bonding supply).`,
            { icon: "ℹ️" }
          );
        }
        const creatorFee = solLamports
          .mul(new BN(CREATOR_FEE_BPS))
          .div(new BN(10_000));
        const netSol = solLamports.sub(creatorFee);

        const expectedTokensOut = calculateTokensOut(
          virtualSolReserve,
          virtualTokenReserve,
          netSol
        );
        const outCapped = BN.min(expectedTokensOut, realTokRem);
        const minTokensOut = outCapped.mul(new BN(99)).div(new BN(100));

        console.log("[higher.run] buy quote (CP + inventory cap):", {
          solLamportsDesired: solLamportsDesired.toString(),
          solLamportsEffective: solLamports.toString(),
          creatorFee: creatorFee.toString(),
          netSol: netSol.toString(),
          expectedTokensOut: expectedTokensOut.toString(),
          outCapped: outCapped.toString(),
          minTokensOut: minTokensOut.toString(),
        });

        const buyPersist: TradePersistBase = {
          mint: mint.toBase58(),
          side: "buy",
          sol_amount_raw: solLamports.toString(),
          token_amount_raw: outCapped.toString(),
          wallet: walletForPersist,
          price_sol: priceSolFromRaw(
            solLamports.toString(),
            outCapped.toString()
          ),
        };

        pendingPersistRef.current = buyPersist;
        await executeAndFinalize(
          "buy",
          () =>
            program.methods
              .buy(solLamports, minTokensOut)
              .accountsPartial(tradeAccounts)
              .rpc(),
          buyPersist
        );
      } else {
        let parsedRawBn: bigint;
        try {
          parsedRawBn = uiTokenStringToRawTruncated(amount, TOKEN_UI_DECIMALS);
        } catch {
          toast.error("Invalid token amount");
          tradePendingRef.current = false;
          setTradePhase("idle");
          return;
        }
        if (parsedRawBn <= BigInt(0)) {
          toast.error("Enter an amount");
          tradePendingRef.current = false;
          setTradePhase("idle");
          return;
        }
        const walletRawBn = BigInt(tokenBalanceRaw || "0");
        if (parsedRawBn > walletRawBn) {
          toast.error("Amount exceeds your token balance");
          tradePendingRef.current = false;
          setTradePhase("idle");
          return;
        }

        console.log("[higher.run] sell amount parse:", {
          inputUi: amount,
          parsedTokenRaw: parsedRawBn.toString(),
          walletTokenRaw: walletRawBn.toString(),
        });

        const tokenRaw = new BN(parsedRawBn.toString());
        const expectedSolOut = calculateSolOut(
          virtualSolReserve,
          virtualTokenReserve,
          tokenRaw
        );
        const minSolOut = expectedSolOut.mul(new BN(99)).div(new BN(100));

        console.log("[higher.run] sell quote:", {
          tokenRaw: tokenRaw.toString(),
          expectedSolOut: expectedSolOut.toString(),
          minSolOut: minSolOut.toString(),
        });

        const sellPersist: TradePersistBase = {
          mint: mint.toBase58(),
          side: "sell",
          sol_amount_raw: expectedSolOut.toString(),
          token_amount_raw: tokenRaw.toString(),
          wallet: walletForPersist,
          price_sol: priceSolFromRaw(
            expectedSolOut.toString(),
            tokenRaw.toString()
          ),
        };

        pendingPersistRef.current = sellPersist;
        await executeAndFinalize(
          "sell",
          () =>
            program.methods
              .sell(tokenRaw, minSolOut)
              .accountsPartial(tradeAccounts)
              .rpc(),
          sellPersist
        );
      }
    } catch (error) {
      if (isAlreadyProcessedError(error)) {
        console.log("[higher.run] duplicate / already-processed (outer) treated as success", {
          action: mode,
        });
        let outerSig = extractSignatureFromError(error);
        if (!outerSig && publicKey) {
          outerSig = await findRecentBondingTradeSignature(
            connection,
            publicKey,
            token.mint
          );
          if (outerSig) {
            console.log(
              "[higher.run] outer duplicate: signature from recent-tx scan",
              outerSig.slice(0, 12) + "…"
            );
          }
        }
        const base = pendingPersistRef.current;
        let outerTradeEventDispatched = false;
        if (base && outerSig) {
          const outerPayload = {
            ...base,
            signature: outerSig,
            timestamp: new Date().toISOString(),
          };
          console.log("[higher.run] DUPLICATE PATH ABOUT TO PERSIST TRADE", outerPayload);
          await persistLaunchpadTrade(outerPayload);
          if (typeof window !== "undefined") {
            window.dispatchEvent(
              new CustomEvent("higher:trade-complete", {
                detail: {
                  mint: outerPayload.mint,
                  timestamp: outerPayload.timestamp,
                  price_sol: outerPayload.price_sol,
                  sol_amount_raw: outerPayload.sol_amount_raw,
                },
              })
            );
            outerTradeEventDispatched = true;
          }
        } else if (base && !outerSig) {
          console.warn(
            "[higher.run] outer duplicate: have persist base but no signature — skipping POST"
          );
        }
        setTradePhase("syncing");
        try {
          const mint = new PublicKey(token.mint);
          const [tokenState] = getTokenStatePDA(mint);
          await refreshBalances();
          try {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const ts = await (program!.account as any).tokenState.fetch(tokenState);
            console.log("[higher.run] refreshed tokenState solRaised (raw):", ts.solRaised?.toString?.());
          } catch (e) {
            console.warn("[higher.run] tokenState refresh failed:", e);
          }
          if (typeof window !== "undefined" && !outerTradeEventDispatched) {
            window.dispatchEvent(
              new CustomEvent("higher:trade-complete", { detail: { mint: mint.toBase58() } })
            );
          }
        } catch (refreshErr) {
          console.warn("[higher.run] refresh after duplicate (outer) failed:", refreshErr);
        }
        toast.success(
          `${mode === "buy" ? "Buy" : "Sell"} completed on-chain. Balances refreshed.`
        );
        setAmount("");
        return;
      }
      console.error("[higher.run] Trade failed:", error);
      if (mode === "sell" && isInsufficientLiquidityError(error)) {
        toast.error(
          "This sell can't complete: the bonding vault doesn't have enough SOL for this payout " +
            "(a small amount must stay for account rent). Older tokens, from before that vault update, " +
            "may need a tiny SOL top-up to the vault before a full sell works.",
          { duration: 9000 }
        );
        return;
      }
      const msg = collectErrorText(error) || "Trade failed";
      toast.error(msg.length > 120 ? msg.slice(0, 120) + "..." : msg);
    } finally {
      pendingPersistRef.current = null;
      tradePendingRef.current = false;
      setTradePhase("idle");
    }
  };

  const quickAmounts = mode === "buy" ? ["0.1", "0.5", "1", "5"] : ["25%", "50%", "75%", "100%"];

  const sellQuickDisabled =
    isTrading ||
    (() => {
      try {
        return BigInt(tokenBalanceRaw || "0") <= BigInt(0);
      } catch {
        return true;
      }
    })();

  const applySellPercent = (pct: number) => {
    let total: bigint;
    try {
      total = BigInt(tokenBalanceRaw || "0");
    } catch {
      toast.error("Could not read token balance");
      return;
    }
    const zero = BigInt(0);
    if (total <= zero) {
      toast.error(`No ${token.ticker} balance`);
      return;
    }
    // 100%: floor wallet balance to 1 decimal place in UI (avoids edge-case full-balance sells).
    let portion: bigint;
    if (pct === 100) {
      const step = BigInt(10) ** BigInt(TOKEN_UI_DECIMALS - 1);
      portion = (total / step) * step;
    } else {
      portion = (total * BigInt(pct)) / BigInt(100);
    }
    if (portion <= zero) {
      toast.error("Amount too small");
      return;
    }
    setAmount(rawTokenToUiAmountString(portion));
  };

  return (
    <div className="p-4">
      {/* Toggle */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex bg-gray-100 rounded-xl p-1 flex-1">
          {(["buy", "sell"] as const).map(m => (
            <button
              key={m}
              type="button"
              disabled={isTrading}
              onClick={() => { if (isTrading) return; setMode(m); setAmount(""); }}
              className={cn(
                "flex-1 py-2 rounded-lg text-sm font-semibold transition-all capitalize",
                mode === m
                  ? m === "buy" ? "bg-green-500 text-white shadow-sm" : "bg-red-500 text-white shadow-sm"
                  : "text-gray-400"
              )}
            >
              {m}
            </button>
          ))}
        </div>
        <span className="text-[10px] text-gray-300 ml-3">1% fee</span>
      </div>

      {/* Input */}
      <div className="relative mb-2">
        <input
          type="number"
          value={amount}
          disabled={isTrading}
          onChange={e => setAmount(e.target.value)}
          placeholder="0"
          className="w-full bg-gray-100 rounded-xl px-4 py-3 text-sm font-medium text-gray-900 placeholder:text-gray-300 focus:outline-none focus:ring-2 focus:ring-green-500/20 transition-all pr-16 disabled:opacity-50"
        />
        <span className="absolute right-4 top-1/2 -translate-y-1/2 text-xs font-semibold text-gray-400">
          {mode === "buy" ? "SOL" : token.ticker}
        </span>
      </div>

      {/* Quick amounts */}
      <div className="flex gap-1.5 mb-3">
        {quickAmounts.map(q => (
          <button
            key={q}
            type="button"
            disabled={mode === "buy" ? isTrading : sellQuickDisabled}
            onClick={() => {
              if (isTrading) return;
              if (mode === "buy") {
                setAmount(q);
                return;
              }
              const pct = parseInt(q, 10);
              if (!Number.isFinite(pct) || pct <= 0) return;
              applySellPercent(pct);
            }}
            className="flex-1 py-1.5 text-[10px] font-medium bg-gray-100 hover:bg-gray-200 text-gray-500 rounded-lg transition-colors disabled:opacity-50"
          >
            {q}
          </button>
        ))}
      </div>

      {/* Estimate */}
      {amount &&
        (mode === "buy" ? buySolUi != null && buySolUi > 0 : amount.trim() !== "") && (
        <div className="bg-gray-100 rounded-xl p-3 mb-3 text-xs text-gray-500">
          You will receive ~<span className="text-gray-900 font-medium ml-1">
            {mode === "buy" ? (
              !bondingQuoteReady ? (
                <span className="text-amber-700">Loading curve…</span>
              ) : buyQuote ? (
                <>
                  {(Number(buyQuote.tokensOutCappedRaw.toString()) / 1e6).toLocaleString(undefined, {
                    maximumFractionDigits: 2,
                  })}{" "}
                  {token.ticker}
                  {buyQuote.saturated ? (
                    <span className="block text-amber-700 font-normal mt-1">
                      Max bonding supply — extra SOL would not mint more (buy will use up to{" "}
                      {(buyQuote.effectiveGrossLamports.toNumber() / 1e9).toFixed(4)} SOL on-chain).
                    </span>
                  ) : null}
                </>
              ) : (
                "—"
              )
            ) : !bondingQuoteReady ? (
              <span className="text-amber-700">Loading curve…</span>
            ) : sellSolEstimateSol != null ? (
              `${sellSolEstimateSol.toFixed(6)} SOL`
            ) : (
              "—"
            )}
          </span>
        </div>
      )}

      {/* Action */}
      {connected ? (
        <button
          type="button"
          onClick={handleTrade}
          disabled={isTrading || !amount}
          className={cn(
            "w-full py-3 rounded-xl font-semibold text-sm transition-all",
            mode === "buy"
              ? "bg-green-500 hover:bg-green-600 text-white disabled:opacity-40"
              : "bg-red-500 hover:bg-red-600 text-white disabled:opacity-40"
          )}
        >
          {isTrading ? (
            <span className="flex items-center justify-center gap-2">
              <ArrowDownUp size={14} className="animate-spin" />
              {tradePhase === "submitting" && "Submitting…"}
              {tradePhase === "confirming" && "Confirming…"}
              {tradePhase === "syncing" && "Updating market…"}
            </span>
          ) : (
            `${mode === "buy" ? "Buy" : "Sell"} ${token.ticker}`
          )}
        </button>
      ) : (
        <WalletMultiButton />
      )}
    </div>
  );
}
