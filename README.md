# higher.run

> **Launch higher. Earn forever. Hold without selling.**

A creator-first Solana token launchpad inspired by Bags.fm. Every token launches on a bonding curve and automatically migrates to an Omnipair GAMM pool at graduation, giving creators perpetual 0.5% swap royalties.

---

## Project Structure

```
higherdotrun/
├── frontend/               # Next.js 15 frontend
│   └── src/
│       ├── app/            # App Router pages
│       │   ├── page.tsx            # Landing page
│       │   ├── create/page.tsx     # Launch a token
│       │   ├── launches/page.tsx   # Live feed
│       │   ├── token/[id]/page.tsx # Token detail + trade
│       │   └── dashboard/page.tsx  # Creator earnings
│       ├── components/
│       │   ├── layout/     # Navbar, Footer
│       │   └── ui/         # TokenCard, TradePanel, BondingCurveChart
│       ├── context/        # WalletContextProvider
│       ├── lib/            # utils, mockData
│       └── types/          # TypeScript types + constants
├── program/                # Anchor smart contract
│   ├── programs/higher-launchpad/src/lib.rs  # Full program
│   ├── tests/              # Integration tests
│   └── Anchor.toml
└── scripts/
    └── deploy-devnet.sh    # One-click devnet deployment
```

---

## Token Economics

| Parameter            | Value                          |
|---------------------|-------------------------------|
| Fixed Supply         | 10,000,000 tokens (6 decimals) |
| Bonding Curve Alloc  | 8,000,000 tokens (80%)        |
| GAMM Pool Seed       | 2,000,000 tokens (20%)        |
| Graduation Threshold | 85 SOL raised                 |
| Creator Royalty      | 0.5% of every GAMM swap (forever) |
| LP Fee               | 0.5% of every GAMM swap       |
| Total Swap Fee       | 1%                            |
| Platform Fee         | 2% of raised SOL at graduation |
| Mint Authority       | Revoked at graduation (anti-rug) |

---

## Bonding Curve Math

Uses a constant-product AMM (like Uniswap v2) with a virtual reserve for a smooth price curve:

```
k = virtual_sol_reserve × virtual_token_reserve

tokens_out = virtual_token_reserve × sol_in / (virtual_sol_reserve + sol_in)
sol_out    = virtual_sol_reserve × tokens_in / (virtual_token_reserve + tokens_in)
```

**Initial virtual reserves:**
- Virtual SOL: 30 SOL (creates smooth initial pricing)
- Virtual Tokens: 8,000,000 (bonding curve allocation)

This gives an initial token price of ~0.0000038 SOL/token and a graduation price of ~0.0000128 SOL/token (~3.4× from launch to graduation).

---

## Graduation Flow

```
1. Bonding curve accumulates 85 SOL
2. `graduate()` instruction is called (permissionless)
3. Platform fee (2%) deducted → platform wallet
4. Mint authority permanently revoked (supply locked at 10M)
5. CPI to Omnipair: initialize_pool() with:
   - 83.3 SOL (net of platform fee)
   - 2,000,000 tokens
   - 1% swap fee (0.5% creator + 0.5% LP)
   - creator_fee_recipient = creator's wallet
6. Token phase = Graduated
7. All Omnipair utilities active: spot swap, lending, borrow, leverage, short
```

---

## Quick Start

### Prerequisites

```bash
# Install Rust
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh

# Install Solana CLI (v1.18+)
sh -c "$(curl -sSfL https://release.solana.com/v1.18.0/install)"

# Install Anchor CLI (v0.31.0)
cargo install --git https://github.com/coral-xyz/anchor avm --locked
avm install 0.31.0
avm use 0.31.0

# Install Node.js (v18+) and npm
```

### Frontend Development

```bash
cd frontend
npm install
npm run dev
# Open http://localhost:3000
```

### Smart Contract (Devnet)

```bash
# One-command deployment
bash scripts/deploy-devnet.sh
```

Or manually:

```bash
cd program

# Build
anchor build

# Get program ID
solana-keygen pubkey target/deploy/higher_launchpad-keypair.json

# Update declare_id! in lib.rs and Anchor.toml with the above ID
# Rebuild: anchor build

# Deploy
anchor deploy --provider.cluster devnet

# Run tests
anchor test --provider.cluster devnet
```

### After Deployment

1. Copy the Program ID from the deploy output
2. Update `PROGRAM_ID` in `frontend/src/types/index.ts`
3. Update `CONNECTION` endpoint in `frontend/src/context/WalletContextProvider.tsx`
4. Restart the frontend

---

## Omnipair GAMM Integration

The graduation flow is designed to CPI into the Omnipair program. The integration point is clearly marked in `lib.rs`:

```rust
// In graduate() instruction:
// TODO: Replace this comment block with the actual Omnipair CPI:
//
// omnipair::cpi::initialize_pool(
//   CpiContext::new_with_signer(...),
//   InitializePoolParams {
//     token_mint: ctx.accounts.mint.key(),
//     initial_sol: sol_for_pool,
//     initial_tokens: GAMM_POOL_ALLOCATION,
//     fee_bps: TOTAL_FEE_BPS,               // 100 = 1%
//     creator_fee_recipient: token_state.creator_fee_recipient,
//     creator_fee_bps: CREATOR_FEE_BPS,     // 50 = 0.5%
//   }
// )?;
```

Once Omnipair publishes their `@omnipair/program-interface` package with CPI support, swap in the real call.

---

## Frontend Pages

| Route | Description |
|-------|-------------|
| `/` | Landing page with hero, stats, trending tokens |
| `/launches` | Live feed with search, filter by phase, sort |
| `/create` | 3-step token creation wizard |
| `/token/[id]` | Token detail: bonding curve chart, trade panel, GAMM info |
| `/dashboard` | Creator dashboard: earnings, claim royalties, token status |

---

## Connecting to Mainnet

1. Change `WalletAdapterNetwork.Devnet` → `WalletAdapterNetwork.Mainnet` in `WalletContextProvider.tsx`
2. Update `GRADUATION_SOL` and `PROGRAM_ID` in `types/index.ts`
3. Deploy program to mainnet: `anchor deploy --provider.cluster mainnet`
4. Update `Anchor.toml` cluster to `mainnet`

---

## Environment Variables

Create `frontend/.env.local`:

```env
NEXT_PUBLIC_SOLANA_RPC_URL=https://api.devnet.solana.com
NEXT_PUBLIC_PROGRAM_ID=HiGHrLaunchPadXXXXXXXXXXXXXXXXXXXXXXXXXXXXX
NEXT_PUBLIC_NETWORK=devnet
```

---

## License

MIT — build freely, credit appreciated.
