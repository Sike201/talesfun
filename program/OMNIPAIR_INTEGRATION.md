# Omnipair GAMM integration (launchpad graduation)

This document describes Omnipair integration for Higher: a **post-graduation** `bootstrap_omnipair_pool` instruction now CPIs Omnipair `initialize`, then sets `token_state.gamm_pool` to the new pair PDA. Graduation itself still does not create the pool; bootstrap is a separate transaction.

## 1. Omnipair program id

| Network | Program ID |
|----------|------------|
| Mainnet  | `omnixgS8fnqHfCcTGKWj6JtKjzpJZ1Y5y9pyFkQDkYE` |
| Devnet   | Same (per [Omnipair docs](https://docs.omnipair.fi/developers/overview)) |

Rust constant: `OMNIPAIR_PROGRAM_ID` in `programs/higher-launchpad/src/lib.rs`.

## 2. What Omnipair expects for a **new** pool

The IDL shipped in `@omnipair/program-interface` defines the main bootstrap instruction as **`initialize`**.

### 2.1 Prerequisites on the cluster

1. **`init_futarchy_authority`** must have been run **once** on that cluster (creates the global `futarchy_authority` PDA under Omnipair).
2. A **`rate_model`** account must exist. Created via **`create_rate_model`** (requires `authority_signer` + new `rate_model` **signer** keypair in the same transaction).
3. **Pair creation fee**: `PAIR_CREATION_FEE_LAMPORTS` = **0.2 SOL** (from Omnipair `constants.rs`) — the **deployer** pays this during `initialize`.

### 2.2 `initialize` — account surface (from IDL)

High-level roles (see full IDL in `node_modules/@omnipair/program-interface/dist/idl.json`):

| Account | Notes |
|---------|--------|
| `deployer` | Signer, writable; pays rent and creation fee; supplies initial liquidity from their ATAs |
| `token0_mint`, `token1_mint` | **Order**: pair PDA seeds are `[b"gamm_pair", token0, token1, params_hash]` — token mints must be in **canonical order** (SDK `derivePairAddress` sorts / uses fixed order per docs) |
| `pair` | PDA derived from seeds above |
| `futarchy_authority` | Global Omnipair PDA |
| `rate_model` | **Signer** in `initialize` (new or existing account per protocol rules) |
| `lp_mint` | Writable; LP mint for the pair |
| `lp_token_metadata` | Metaplex metadata PDA for LP mint |
| `deployer_lp_token_account` | Writable |
| `reserve0_vault`, `reserve1_vault` | PDAs per pair + mint |
| `collateral0_vault`, `collateral1_vault` | PDAs per pair + mint |
| `deployer_token0_account`, `deployer_token1_account` | **Funded ATAs** debited for `amount0_in` / `amount1_in` |
| `team_treasury`, `team_treasury_wsol_account` | Protocol treasury (addresses must match what Omnipair’s `initialize` validates on-chain) |
| `system_program`, `token_program`, `token_2022_program`, `token_metadata_program`, `associated_token_program`, `rent` | Fixed program ids |
| `event_authority`, `program` | Omnipair event CPI pattern |

### 2.3 `InitializeAndBootstrapArgs` (Borsh payload)

Includes: `swap_fee_bps`, `half_life`, optional IRM fields, **`params_hash` [u8;32]**, `version`, **`amount0_in`**, **`amount1_in`**, **`min_liquidity_out`**, `lp_name`, `lp_symbol`, `lp_uri`.

The **`params_hash`** must match the pair PDA derivation (see Omnipair SDK `computeParamsHash` example in docs).

### 2.4 SOL vs WSOL

Omnipair pairs use **SPL mints**. The “SOL side” is almost always **wrapped SOL** (`So11111111111111111111111111111111111111112`). Your launchpad holds **native SOL** in `sol_vault` (system account). Migration must:

1. Allocate/fund a **WSOL ATA** for the entity acting as `deployer` (or use an intermediate PDA).
2. **`sync_native`** / transfer lamports so the WSOL ATA balance matches the SOL leg you want to seed.
3. Match **`amount0_in` / `amount1_in`** to the **sorted** token0/token1 semantics.

### 2.5 LP mint / pool state

`initialize` **creates** the pair account, LP mint, vaults, and initial LP position for `deployer`. There is no separate “pool id” besides the **`pair` PDA** — that address is what you should persist in `token_state.gamm_pool`.

## 3. Implemented path: `bootstrap_omnipair_pool`

1. **Instruction** (Anchor): `bootstrap_omnipair_pool(config: OmnipairPoolConfigArgs)`  
   - Requires `token_state.phase == Graduated` and `gamm_pool == default`.  
   - Moves **all** spendable lamports in `sol_vault` (after rent) to the `deployer` WSOL ATA, `sync_native`, then moves **only** the token amount needed to match the **terminal bonding-curve spot** (`virtual_token_reserve / virtual_sol_reserve` × SOL, floor in u128), **burns** the remaining `token_vault` balance with the `sol_vault` PDA as authority, then CPIs Omnipair with matching `amount0_in` / `amount1_in`.  
   - **`remaining_accounts`**: exactly **25** accounts, **IDL order** for Omnipair `initialize` (see `@omnipair/program-interface`).  
   - Raw `invoke` into `OMNIPAIR_PROGRAM_ID` (no typed Omnipair CPI crate).

2. **Signers (outer transaction)**  
   - **`deployer`**: pays Omnipair rent + **0.2 SOL** pair-creation fee (to `team_treasury_wsol_account`), signs bootstrap.  
   - **`rate_model`**: published IDL marks this as **signer**; the app generates an ephemeral keypair per bootstrap (same tx). If your deployed Omnipair binary matches **omnipair-rs** `main` where `rate_model` is **`init` without signer**, you may need to adjust client metas to match the live program.  
   - **`lp_mint`**: **82-byte** uninitialized mint account; client allocates with `SystemProgram.createAccount` before the bootstrap ix.

3. **Prerequisites on the cluster**  
   - `init_futarchy_authority` has been run (so `futarchy_authority` + `team_treasury` / WSOL ATA exist).  
   - Client reads `futarchyAuthority` to obtain `recipients.teamTreasury` and derives `team_treasury_wsol_account`.

4. **Params hash** must match Omnipair’s on-chain check (see `omnipair_cpi.rs` / `computeOmnipairParamsHash` in the frontend). **`version`** in args must be **1**.

5. **Frontend**: `sendBootstrapOmnipairPoolTx` (see `frontend/src/lib/omnipairBootstrap.ts`) builds the Omnipair `initialize` ix to extract account metas, then calls the launchpad with `.remainingAccounts(...)`. Graduated token page exposes **Bootstrap Omnipair pool** when `gamm_pool` is unset.

6. **Production Omnipair builds** (`feature = "production"`): on-chain code requires the **LP mint address** (base58) to end with **`omLP`**. A random `Keypair` will **fail** on that build; you need a vanity key or an Omnipair-supported mint-creation path. **Devnet / non-production** builds typically skip this check — test there first.

## 4. What still blocks “real swap / borrow” in the UI

Pool **existence** is on-chain after a successful bootstrap; **trading and lending** still need separate work: building Omnipair `swap` / `add_collateral` / `borrow` instructions, user positions, and (optionally) indexer data. No fake stats are added in this repo.

## 5. Frontend / Supabase

- `gamm_pool == Pubkey::default` ⇒ no Omnipair pair recorded on-chain.
- After integration, persist the **pair** address; frontend can link to Solscan / Omnipair apps.
- **Supabase phase backfill** (stale `bonding` rows for already-graduated mints):
  - **Preferred:** call your app’s `POST /api/tokens/<mint>/sync-phase` for each mint (reads chain, updates `phase`). Script example:

```bash
# With the Next app running (or use production URL)
for mint in mint1 mint2 mint3; do
  curl -sS -X POST "http://localhost:3000/api/tokens/${mint}/sync-phase"
done
```

  - **Manual SQL** (only if you *know* mints are graduated on-chain but DB is wrong):

```sql
UPDATE tokens SET phase = 'graduated' WHERE mint IN ('...','...');
```

## 6. References

- Docs: https://docs.omnipair.fi/developers/overview  
- TypeScript SDK / IDL: `npm install @omnipair/program-interface`  
- Source: https://github.com/omnipair/omnipair-rs  
