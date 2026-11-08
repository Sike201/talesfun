#!/usr/bin/env bash
# =============================================================================
# Higher launchpad — buffer-based upgrade (large .so)
# =============================================================================
#
# WHY DEFAULT `anchor deploy` / ONE-SHOT `solana program deploy` OFTEN FAILS:
#
# - Upgradeable programs are uploaded in many small write transactions, then a
#   final "set upgrade authority / deploy" step. A naive deploy ties this to one
#   flow with a single recent blockhash window (~60s per hash) and a bounded
#   number of resign iterations (--max-sign-attempts, default 5).
# - Large ELFs (~500KB) need many writes; on public RPCs you hit slow
#   confirmation, rate limits, and "Blockhash expired" / "Max retries exceeded"
#   before the upload finishes.
#
# BUFFER PATTERN:
# 1) `program write-buffer` — uploads ONLY to a throwaway buffer account. You
#    can raise --max-sign-attempts and retry; partial progress can resume if you
#    reuse the same --buffer keypair (see `solana program write-buffer --help`).
# 2) `program deploy --buffer ...` — one short upgrade tx that points the live
#    program at the already-uploaded buffer (avoids re-uploading on failure).
#
# TUNE:
# - Use a dedicated RPC (Helius, Triton, etc.) via SOLANA_URL / -u.
# - Raise CU price on congested clusters: COMPUTE_UNIT_PRICE_MICROLAMPORTS.
# - Raise MAX_SIGN_ATTEMPTS if uploads still expire (each attempt ~60s window).
#
set -euo pipefail

PROGRAM_ID="${PROGRAM_ID:-72bwK5ffBy2vRTu694L8WtQ6xaXYA8ePJtxB34fnV2wv}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROGRAM_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
BINARY="${BINARY:-${PROGRAM_ROOT}/target/deploy/higher_launchpad.so}"
# Same keypair as Anchor.toml [provider] wallet — must be the upgrade authority.
UPGRADE_AUTHORITY_KEYPAIR="${UPGRADE_AUTHORITY_KEYPAIR:-$HOME/.config/solana/id.json}"
# Optional: override cluster (otherwise uses `solana config get`)
SOLANA_URL="${SOLANA_URL:-}"
# Buffer keypair: reuse file to allow resuming a failed write-buffer
BUFFER_KEYPAIR="${BUFFER_KEYPAIR:-${PROGRAM_ROOT}/target/deploy/higher_launchpad_buffer.json}"
# Extra headroom when extending ProgramData (bytes)
EXTEND_SLACK="${EXTEND_SLACK:-65536}"
# More retries → longer total window before giving up on blockhash expiry
MAX_SIGN_ATTEMPTS="${MAX_SIGN_ATTEMPTS:-50}"
# microlamports per CU (0 = omit). Example: 50000 on congested devnet/mainnet
COMPUTE_UNIT_PRICE_MICROLAMPORTS="${COMPUTE_UNIT_PRICE_MICROLAMPORTS:-0}"

SOLANA_BASE=( -k "${UPGRADE_AUTHORITY_KEYPAIR}" )
if [[ -n "${SOLANA_URL}" ]]; then
  SOLANA_BASE+=( -u "${SOLANA_URL}" )
fi

CU_FLAGS=()
if [[ "${COMPUTE_UNIT_PRICE_MICROLAMPORTS}" != "0" && -n "${COMPUTE_UNIT_PRICE_MICROLAMPORTS}" ]]; then
  CU_FLAGS+=( --with-compute-unit-price "${COMPUTE_UNIT_PRICE_MICROLAMPORTS}" )
fi

die() { echo "error: $*" >&2; exit 1; }

[[ -f "${BINARY}" ]] || die "missing binary: ${BINARY} (run anchor build first)"
[[ -f "${UPGRADE_AUTHORITY_KEYPAIR}" ]] || die "missing upgrade authority keypair: ${UPGRADE_AUTHORITY_KEYPAIR}"

command -v solana >/dev/null || die "solana CLI not found in PATH"

echo "== Solana config (effective)"
if [[ -n "${SOLANA_URL}" ]]; then
  echo "RPC: ${SOLANA_URL} (from SOLANA_URL)"
else
  solana config get || true
fi
echo "Upgrade authority keypair: ${UPGRADE_AUTHORITY_KEYPAIR}"
echo "Program ID: ${PROGRAM_ID}"
echo "Binary: ${BINARY}"
echo ""

NEW_SIZE="$(wc -c < "${BINARY}" | tr -d ' ')"
echo "== Local ELF size (bytes): ${NEW_SIZE}"

echo ""
echo "== On-chain program (upgradeable metadata)"
solana program show "${PROGRAM_ID}" "${SOLANA_BASE[@]}" --output json | {
  if command -v jq >/dev/null 2>&1; then
    jq '{ programId, programdataAddress, authority, dataLen, lastDeploySlot }'
  else
    cat
  fi
}

CURRENT_LEN=""
if command -v jq >/dev/null 2>&1; then
  CURRENT_LEN="$(solana program show "${PROGRAM_ID}" "${SOLANA_BASE[@]}" --output json | jq -r '.dataLen // empty')"
fi
if [[ -z "${CURRENT_LEN}" || "${CURRENT_LEN}" == "null" ]]; then
  echo "warning: could not read dataLen via jq; compare 'Data Length' from text output manually:"
  solana program show "${PROGRAM_ID}" "${SOLANA_BASE[@]}" || true
else
  echo "On-chain ProgramData logical length (dataLen): ${CURRENT_LEN}"
  if [[ "${NEW_SIZE}" -gt "${CURRENT_LEN}" ]]; then
    NEED_EXTEND=$(( NEW_SIZE - CURRENT_LEN + EXTEND_SLACK ))
    echo ""
    echo "== ELF is larger than ProgramData — extending by ${NEED_EXTEND} bytes"
    echo "    (ProgramData will grow; upgrade authority pays rent for the delta)"
    solana program extend "${PROGRAM_ID}" "${NEED_EXTEND}" "${SOLANA_BASE[@]}" "${CU_FLAGS[@]}"
  else
    echo "ELF fits in existing ProgramData (no extend needed)."
  fi
fi

echo ""
echo "== Ensure buffer keypair exists: ${BUFFER_KEYPAIR}"
if [[ ! -f "${BUFFER_KEYPAIR}" ]]; then
  echo "Generating new buffer keypair (save this path to resume failed uploads)..."
  solana-keygen new --no-bip39-passphrase -o "${BUFFER_KEYPAIR}" --force
fi
BUFFER_PUB="$(solana-keygen pubkey "${BUFFER_KEYPAIR}")"
echo "Buffer pubkey: ${BUFFER_PUB}"

echo ""
echo "== Step 1/2: write-buffer (upload ELF to buffer; may take many transactions)"
# --use-rpc: avoid TPU path issues on some hosts / VPNs
solana program write-buffer "${BINARY}" \
  "${SOLANA_BASE[@]}" \
  --buffer "${BUFFER_KEYPAIR}" \
  --max-sign-attempts "${MAX_SIGN_ATTEMPTS}" \
  --use-rpc \
  "${CU_FLAGS[@]}"

echo ""
echo "== Step 2/2: deploy from buffer → upgrade program (short tx)"
# Pass the same .so so the CLI can verify / size-check against the buffer; the
# upgrade uses the buffer account as the source of truth.
solana program deploy "${BINARY}" \
  "${SOLANA_BASE[@]}" \
  --program-id "${PROGRAM_ID}" \
  --buffer "${BUFFER_KEYPAIR}" \
  --upgrade-authority "${UPGRADE_AUTHORITY_KEYPAIR}" \
  --max-sign-attempts "${MAX_SIGN_ATTEMPTS}" \
  --use-rpc \
  "${CU_FLAGS[@]}"

echo ""
echo "== Done. Verify:"
solana program show "${PROGRAM_ID}" "${SOLANA_BASE[@]}"
