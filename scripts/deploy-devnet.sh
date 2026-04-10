#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# higher.run — Devnet Deployment Script
# ─────────────────────────────────────────────────────────────────────────────
set -e

echo ""
echo "╔══════════════════════════════════════════════╗"
echo "║         higher.run Devnet Deployment         ║"
echo "╚══════════════════════════════════════════════╝"
echo ""

# 1. Check prerequisites
command -v solana >/dev/null 2>&1 || { echo "❌ solana CLI not found. Install: https://docs.solana.com/cli/install-solana-cli-tools"; exit 1; }
command -v anchor >/dev/null 2>&1 || { echo "❌ anchor CLI not found. Install: https://www.anchor-lang.com/docs/installation"; exit 1; }
command -v node >/dev/null 2>&1 || { echo "❌ node not found."; exit 1; }

echo "✅ Prerequisites found"

# 2. Configure Solana for devnet
echo ""
echo "📡 Configuring Solana CLI for devnet..."
solana config set --url devnet

# 3. Check/create wallet
WALLET_PATH="$HOME/.config/solana/id.json"
if [ ! -f "$WALLET_PATH" ]; then
  echo "🔑 No wallet found, generating new keypair..."
  solana-keygen new --outfile "$WALLET_PATH" --no-bip39-passphrase
fi

PUBKEY=$(solana-keygen pubkey "$WALLET_PATH")
echo "👛 Wallet: $PUBKEY"

# 4. Airdrop SOL if balance is low
BALANCE=$(solana balance --url devnet | grep -oP '[\d.]+')
echo "💰 Current balance: $BALANCE SOL"

if (( $(echo "$BALANCE < 2" | bc -l) )); then
  echo "⬇️  Requesting devnet airdrop..."
  solana airdrop 2 --url devnet
  sleep 3
  echo "💰 New balance: $(solana balance --url devnet)"
fi

# 5. Build the Anchor program
echo ""
echo "🔨 Building Anchor program..."
cd "$(dirname "$0")/../program"
anchor build

# 6. Get the program ID
PROGRAM_ID=$(solana-keygen pubkey target/deploy/higher_launchpad-keypair.json)
echo "📦 Program ID: $PROGRAM_ID"

# 7. Update program ID in Anchor.toml and lib.rs
echo "📝 Updating program IDs..."
sed -i.bak "s/HiGHrLaunchPadXXXXXXXXXXXXXXXXXXXXXXXXXXXXX/$PROGRAM_ID/g" Anchor.toml
sed -i.bak "s/HiGHrLaunchPadXXXXXXXXXXXXXXXXXXXXXXXXXXXXX/$PROGRAM_ID/g" programs/higher-launchpad/src/lib.rs

# Rebuild with updated ID
echo "🔨 Rebuilding with correct program ID..."
anchor build

# 8. Deploy
echo ""
echo "🚀 Deploying to devnet..."
anchor deploy --provider.cluster devnet

# 9. Update frontend program ID
FRONTEND_TYPES_DIR="../frontend/src/types"
if [ -f "$FRONTEND_TYPES_DIR/index.ts" ]; then
  echo "📝 Updating frontend program ID..."
  sed -i.bak "s/HiGHr1aunchPadProgramIDxxxxxxxxxxxxxxxxxx/$PROGRAM_ID/g" "$FRONTEND_TYPES_DIR/index.ts"
fi

# 10. Initialize platform
echo ""
echo "🏗️  Initializing platform state..."
PLATFORM_FEE_WALLET=$(solana-keygen pubkey "$WALLET_PATH")

cat > /tmp/init-platform.ts << EOF
import * as anchor from "@coral-xyz/anchor";
import { PublicKey, SystemProgram } from "@solana/web3.js";

async function main() {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.HigherLaunchpad;

  const [platformPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("platform")],
    program.programId
  );

  try {
    await program.methods
      .initializePlatform(new PublicKey("$PLATFORM_FEE_WALLET"))
      .accounts({
        platform: platformPda,
        authority: provider.wallet.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    console.log("✅ Platform initialized! PDA:", platformPda.toBase58());
  } catch (e) {
    console.log("Platform may already be initialized:", e.message);
  }
}

main().catch(console.error);
EOF

anchor run init || echo "ℹ️  Platform initialization skipped (may already exist)"

echo ""
echo "╔══════════════════════════════════════════════╗"
echo "║           Deployment Complete! 🎉            ║"
echo "╚══════════════════════════════════════════════╝"
echo ""
echo "Program ID:   $PROGRAM_ID"
echo "Network:      Devnet"
echo "Explorer:     https://explorer.solana.com/address/$PROGRAM_ID?cluster=devnet"
echo ""
echo "Next steps:"
echo "  1. cd ../frontend && npm run dev"
echo "  2. Open http://localhost:3000"
echo "  3. Connect Phantom wallet (devnet)"
echo "  4. Launch a token!"
echo ""
