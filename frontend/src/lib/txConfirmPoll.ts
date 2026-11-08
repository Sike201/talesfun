import bs58 from "bs58";
import {
  Connection,
  Transaction,
  type SendOptions,
} from "@solana/web3.js";

export function signatureFromSignedLegacyTransaction(tx: Transaction): string | null {
  const buf = tx.signature;
  if (!buf || buf.length === 0) return null;
  return bs58.encode(buf);
}

function errorText(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

export function isDuplicateAlreadyProcessedSendError(e: unknown): boolean {
  const t = errorText(e);
  return (
    /already been processed/i.test(t) ||
    /AlreadyProcessed/i.test(t) ||
    /duplicate signature/i.test(t)
  );
}

/**
 * Websocket confirm timeouts / RPC noise — tx may still have landed.
 */
export function isTransientConfirmationFailure(e: unknown): boolean {
  const t = errorText(e).toLowerCase();
  return (
    t.includes("not confirmed") ||
    t.includes("timeout") ||
    t.includes("transactionexpired") ||
    t.includes("blockheight") ||
    (t.includes("ws") && t.includes("undefined")) ||
    t.includes("websocket") ||
    t.includes("failed to confirm")
  );
}

/**
 * Confirm via `getSignatureStatuses` only (avoids flaky WS `confirmTransaction`).
 */
export async function pollSignatureUntilConfirmed(
  connection: Connection,
  signature: string,
  opts?: { timeoutMs?: number }
): Promise<void> {
  const timeoutMs = opts?.timeoutMs ?? 120_000;
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
      throw new Error(`Transaction failed on-chain: ${JSON.stringify(st.err)}`);
    }
    const c = st.confirmationStatus;
    if (c === "confirmed" || c === "finalized") {
      return;
    }
    await new Promise(r => setTimeout(r, 350));
  }
  throw new Error(
    `Transaction confirmation timed out after ${timeoutMs}ms (signature status polling)`
  );
}

/**
 * Send serialized tx, then confirm by polling. Handles duplicate-send errors.
 */
export async function sendRawTransactionWithPollingConfirm(
  connection: Connection,
  raw: Uint8Array,
  signedLegacyTx: Transaction,
  sendOptions?: SendOptions
): Promise<string> {
  let signature: string;
  try {
    signature = await connection.sendRawTransaction(raw, {
      skipPreflight: false,
      maxRetries: 3,
      ...sendOptions,
    });
    console.info("[txConfirmPoll] sendRawTransaction ok, signature", signature);
  } catch (e) {
    const recovered = signatureFromSignedLegacyTransaction(signedLegacyTx);
    if (recovered && isDuplicateAlreadyProcessedSendError(e)) {
      console.warn(
        "[txConfirmPoll] send reported duplicate/already-processed; using signed tx signature",
        recovered
      );
      signature = recovered;
    } else {
      const recoveredLog = signatureFromSignedLegacyTransaction(signedLegacyTx);
      console.warn("[txConfirmPoll] sendRawTransaction threw", {
        recoveredSignature: recoveredLog,
        error: errorText(e),
      });
      throw e;
    }
  }

  console.info("[txConfirmPoll] polling signature status (HTTP, no WS confirm)");
  await pollSignatureUntilConfirmed(connection, signature);
  console.info("[txConfirmPoll] polling confirmed", signature);
  return signature;
}
