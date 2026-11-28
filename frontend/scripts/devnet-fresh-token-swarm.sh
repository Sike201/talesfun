#!/usr/bin/env bash
# Fresh token → graduate → Omnipair → N traders (buy/sell/long/short/borrow).
#
# From frontend/:
#   chmod +x scripts/devnet-fresh-token-swarm.sh
#   TRADERS=12 FUND_SOL=0.28 STRESS_ROUNDS=3 ./scripts/devnet-fresh-token-swarm.sh
#
# Needs:
#   ~/.config/solana/id.json       ≥ graduation(0.5) + bootstrap(~0.3) + fees  ≈ 1.0 SOL
#   ~/.config/solana/phantom.json  ≥ TRADERS * FUND_SOL                         ≈ 3–6 SOL
set -euo pipefail
cd "$(dirname "$0")/.."

set -a
# shellcheck disable=SC1091
source .env.local
set +a

TRADERS="${TRADERS:-12}"
FUND_SOL="${FUND_SOL:-0.28}"
STRESS_ROUNDS="${STRESS_ROUNDS:-3}"
STRESS_MINUTES="${STRESS_MINUTES:-8}"

mkdir -p .e2e-tmp
LOG=".e2e-tmp/fresh-token-swarm.log"
: > "$LOG"

need_id=$(node -e "console.log((Number(process.env.NEXT_PUBLIC_GRADUATION_SOL||0.5)+0.6).toFixed(2))")
need_phantom=$(node -e "console.log((${TRADERS}*${FUND_SOL}+0.2).toFixed(2))")

echo "== balance check ==" | tee -a "$LOG"
npx tsx --env-file=.env.local -e "
import { Connection, Keypair, LAMPORTS_PER_SOL } from '@solana/web3.js';
import fs from 'fs'; import path from 'path';
const c = new Connection(process.env.NEXT_PUBLIC_SOLANA_RPC_URL!, 'confirmed');
const id = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(path.join(process.env.HOME!,'.config/solana/id.json'),'utf8'))));
const ph = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(path.join(process.env.HOME!,'.config/solana/phantom.json'),'utf8'))));
const idBal = (await c.getBalance(id.publicKey))/LAMPORTS_PER_SOL;
const phBal = (await c.getBalance(ph.publicKey))/LAMPORTS_PER_SOL;
console.log('id     ', id.publicKey.toBase58(), idBal.toFixed(4), 'SOL  (need ≥ ${need_id})');
console.log('phantom', ph.publicKey.toBase58(), phBal.toFixed(4), 'SOL  (need ≥ ${need_phantom})');
if (idBal < ${need_id}) process.exit(10);
if (phBal < ${need_phantom}) process.exit(11);
" 2>&1 | tee -a "$LOG"
bal_rc=${PIPESTATUS[0]}
if [[ "$bal_rc" -eq 10 ]]; then
  echo "Fund id.json via https://faucet.solana.com → need ≥ ${need_id} SOL" | tee -a "$LOG"
  exit 1
fi
if [[ "$bal_rc" -eq 11 ]]; then
  echo "Fund phantom.json via https://faucet.solana.com → need ≥ ${need_phantom} SOL" | tee -a "$LOG"
  exit 1
fi

echo "== 1/2 launch + graduate + short MM ==" | tee -a "$LOG"
STRESS_ROUNDS="$STRESS_ROUNDS" STRESS_MINUTES="$STRESS_MINUTES" \
  npx tsx --env-file=.env.local scripts/devnet-talesfun-test-stress.ts 2>&1 | tee -a "$LOG"

MINT=$(node -e "console.log(JSON.parse(require('fs').readFileSync('.e2e-tmp/talesfun-test-mint.json','utf8')).mint)")
echo "mint=$MINT" | tee -a "$LOG"
echo "page=http://localhost:3000/token/$MINT" | tee -a "$LOG"

# Ensure gamm_pool is written for multi-stress-close
npx tsx --env-file=.env.local -e "
import fs from 'fs';
import { Connection, PublicKey } from '@solana/web3.js';
import { getReadOnlyProgram, getTokenStatePDA, tokenStateToToken } from './src/lib/program.ts';
const meta = JSON.parse(fs.readFileSync('.e2e-tmp/talesfun-test-mint.json','utf8'));
const c = new Connection(process.env.NEXT_PUBLIC_SOLANA_RPC_URL!, 'confirmed');
const mint = new PublicKey(meta.mint);
const [pda] = getTokenStatePDA(mint);
const program = getReadOnlyProgram(c);
const state = await (program.account as any).tokenState.fetch(pda);
const t = tokenStateToToken(state, mint.toBase58());
if (!t.gammPool) throw new Error('not graduated / no gamm pool yet');
meta.gammPool = t.gammPool;
meta.phase = t.phase;
fs.writeFileSync('.e2e-tmp/talesfun-test-mint.json', JSON.stringify(meta, null, 2));
console.log('gammPool', t.gammPool);
" 2>&1 | tee -a "$LOG"

echo "== 2/2 multi-trader swarm (${TRADERS}) ==" | tee -a "$LOG"
TRADERS="$TRADERS" \
  STRESS_PAYER_KEYPAIR="$HOME/.config/solana/phantom.json" \
  npx tsx --env-file=.env.local scripts/devnet-e2e-multi-stress-close.ts 2>&1 | tee -a "$LOG"

echo "== DONE ==" | tee -a "$LOG"
echo "mint=$MINT"
echo "page=http://localhost:3000/token/$MINT"
echo "log=$LOG"
echo "stats=.e2e-tmp/multi-stress-close-stats.json"
