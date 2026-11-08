use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    metadata::{
        create_metadata_accounts_v3, mpl_token_metadata::types::DataV2,
        CreateMetadataAccountsV3, Metadata,
    },
    token::{
        self, Burn, CloseAccount, Mint, MintTo, SetAuthority, Token, TokenAccount, Transfer,
    },
};
use anchor_spl::token::spl_token::instruction::AuthorityType;
use anchor_lang::solana_program::{
    instruction::Instruction,
    program::invoke,
    sysvar::SysvarId,
};

mod omnipair_cpi;

use omnipair_cpi::{
    build_omnipair_initialize_ix_data,
    omnipair_params_hash_matches,
    OmnipairPoolConfigArgs,
    OMNIPAIR_INITIALIZE_ACCOUNT_LEN,
};

declare_id!("72bwK5ffBy2vRTu694L8WtQ6xaXYA8ePJtxB34fnV2wv");

/// Omnipair GAMM program id (mainnet and devnet — see Omnipair docs).
/// Omnipair program targeted by `bootstrap_omnipair_pool` CPI.
/// For self-hosted devnet Omnipair, replace with your deployed program id and redeploy this program.
/// Must match `NEXT_PUBLIC_OMNIPAIR_PROGRAM_ID` / `OMNIPAIR_PROGRAM_ID` in the frontend.
pub const OMNIPAIR_PROGRAM_ID: Pubkey = pubkey!("GP5yjX245UK28bLJQgG4WSHGT9ZyeoC6QpgwWAjekWv4");

pub const TOKEN_2022_PROGRAM_ID: Pubkey = pubkey!("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
pub const MPL_TOKEN_METADATA_ID: Pubkey = pubkey!("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");

// ─── Constants ────────────────────────────────────────────────────────────────

/// Every token has exactly 1,000,000,000 units (with 6 decimals = 1_000_000_000_000_000 raw)
pub const FIXED_SUPPLY: u64 = 1_000_000_000_000_000; // 1B * 10^6
pub const FIXED_SUPPLY_UI: u64 = 1_000_000_000;
pub const TOKEN_DECIMALS: u8 = 6;

/// Net SOL into the curve (after creator fee) cumulated in `token_state.sol_raised` before graduation.
/// Production: **85 SOL** — exhausts ~793.1M bonding tokens (Pump-like completion).
/// Dev-only: enable Cargo feature `dev-graduation` for **5 SOL** (early graduation ~153M sold; infra/UI tests only).
#[cfg(feature = "dev-graduation")]
pub const GRADUATION_THRESHOLD_LAMPORTS: u64 = 5_000_000_000;
#[cfg(not(feature = "dev-graduation"))]
pub const GRADUATION_THRESHOLD_LAMPORTS: u64 = 85_000_000_000;

/// Creator fee: 50 bps = 0.5%
pub const CREATOR_FEE_BPS: u16 = 50;

/// LP fee: 50 bps = 0.5%
pub const LP_FEE_BPS: u16 = 50;

/// Total swap fee: 100 bps = 1%
pub const TOTAL_FEE_BPS: u16 = 100;

/// Virtual token reserve for smooth curve — matches pump.fun math
pub const VIRTUAL_TOKEN_RESERVE_INITIAL: u64 = 1_073_000_191_000_000; // 1.073B * 10^6

/// Bonding curve — tokens available for sale (~79.3% of supply)
pub const BONDING_CURVE_ALLOCATION: u64 = 793_100_000_000_000; // 793.1M * 10^6

/// Tokens seeded into GAMM pool at graduation (~20.7% of supply)
pub const GAMM_POOL_ALLOCATION: u64 = 206_900_000_000_000; // 206.9M * 10^6

/// Platform fee on graduation: 2% of raised SOL
pub const PLATFORM_FEE_BPS: u16 = 200;

/// `sol_vault` is a 0-byte System-owned PDA; this is its rent-exempt lamport minimum.
/// Accounting invariant: `sol_vault.lamports() == rent_exempt_min + real_sol_reserve`.
/// `real_sol_reserve` is **only** tradable liquidity from buys (net of curve fees); it never includes the rent cushion.
fn sol_vault_rent_exempt_min() -> Result<u64> {
    Ok(Rent::get()?.minimum_balance(0))
}

// ─── Program ──────────────────────────────────────────────────────────────────

#[program]
pub mod higher_launchpad {
    use super::*;

    /// Initialize the global platform state (called once by admin).
    pub fn initialize_platform(
        ctx: Context<InitializePlatform>,
        platform_fee_recipient: Pubkey,
    ) -> Result<()> {
        let platform = &mut ctx.accounts.platform;
        platform.authority = ctx.accounts.authority.key();
        platform.fee_recipient = platform_fee_recipient;
        platform.total_tokens_created = 0;
        platform.total_sol_raised = 0;
        platform.total_graduated = 0;
        platform.bump = ctx.bumps.platform;
        Ok(())
    }

    /// Create a new token and launch it on the bonding curve.
    /// Mints the full 10M supply to the bonding curve vault.
    pub fn create_token(
        ctx: Context<CreateToken>,
        params: CreateTokenParams,
    ) -> Result<()> {
        let token_state = &mut ctx.accounts.token_state;

        // Validate inputs
        require!(params.name.len() <= 32, LaunchpadError::NameTooLong);
        require!(params.symbol.len() <= 10, LaunchpadError::SymbolTooLong);
        require!(params.uri.len() <= 200, LaunchpadError::UriTooLong);

        // Set fee recipient: use provided or default to creator
        let fee_recipient = if params.creator_fee_recipient == Pubkey::default() {
            ctx.accounts.creator.key()
        } else {
            params.creator_fee_recipient
        };

        // Populate token state
        token_state.mint = ctx.accounts.mint.key();
        token_state.creator = ctx.accounts.creator.key();
        token_state.creator_fee_recipient = fee_recipient;
        token_state.name = params.name.clone();
        token_state.symbol = params.symbol.clone();
        token_state.uri = params.uri.clone();
        token_state.created_at = Clock::get()?.unix_timestamp;
        token_state.phase = TokenPhase::Bonding;
        token_state.sol_raised = 0;
        token_state.tokens_sold = 0;
        token_state.total_supply = FIXED_SUPPLY;
        token_state.virtual_sol_reserve = 30_000_000_000; // 30 SOL virtual reserve for smooth curve
        token_state.virtual_token_reserve = VIRTUAL_TOKEN_RESERVE_INITIAL;
        // Tradable SOL only — rent cushion lives in `sol_vault` lamports but is not counted here.
        token_state.real_sol_reserve = 0;
        token_state.real_token_reserve = BONDING_CURVE_ALLOCATION;
        token_state.creator_fees_accumulated = 0;
        token_state.gamm_pool = Pubkey::default();
        token_state.bump = ctx.bumps.token_state;
        token_state.vault_bump = ctx.bumps.sol_vault;

        // Signer seeds for mint_authority PDA — shared by both CPIs below
        let mint_key = ctx.accounts.mint.key();
        let seeds = &[b"mint_authority", mint_key.as_ref(), &[ctx.bumps.mint_authority]];
        let signer_seeds = &[&seeds[..]];

        // Mint full supply to bonding curve token vault (mint_authority PDA must sign)
        let cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.key(),
            MintTo {
                mint: ctx.accounts.mint.to_account_info(),
                to: ctx.accounts.token_vault.to_account_info(),
                authority: ctx.accounts.mint_authority.to_account_info(),
            },
            signer_seeds,
        );
        token::mint_to(cpi_ctx, FIXED_SUPPLY)?;

        // Create on-chain metadata via Metaplex

        create_metadata_accounts_v3(
            CpiContext::new_with_signer(
                ctx.accounts.metadata_program.key(),
                CreateMetadataAccountsV3 {
                    metadata: ctx.accounts.metadata.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    mint_authority: ctx.accounts.mint_authority.to_account_info(),
                    payer: ctx.accounts.creator.to_account_info(),
                    update_authority: ctx.accounts.mint_authority.to_account_info(),
                    system_program: ctx.accounts.system_program.to_account_info(),
                    rent: ctx.accounts.rent.to_account_info(),
                },
                signer_seeds,
            ),
            DataV2 {
                name: params.name,
                symbol: params.symbol,
                uri: params.uri,
                seller_fee_basis_points: CREATOR_FEE_BPS,
                creators: None,
                collection: None,
                uses: None,
            },
            true,
            true,
            None,
        )?;

        // Update platform stats
        let platform = &mut ctx.accounts.platform;
        platform.total_tokens_created += 1;

        emit!(TokenCreated {
            mint: ctx.accounts.mint.key(),
            creator: ctx.accounts.creator.key(),
            creator_fee_recipient: fee_recipient,
            name: token_state.name.clone(),
            symbol: token_state.symbol.clone(),
            timestamp: token_state.created_at,
        });

        Ok(())
    }

    /// Buy tokens from the bonding curve.
    /// Uses constant-product AMM: k = virtual_sol * virtual_tokens
    /// Deducts 0.5% creator fee before curve calculation.
    pub fn buy(ctx: Context<Trade>, sol_amount: u64, min_tokens_out: u64) -> Result<()> {
        let token_state = &mut ctx.accounts.token_state;

        require!(token_state.phase == TokenPhase::Bonding, LaunchpadError::NotOnBondingCurve);
        require!(sol_amount > 0, LaunchpadError::ZeroAmount);

        // Deduct creator fee before curve calculation
        let creator_fee = (sol_amount as u128 * CREATOR_FEE_BPS as u128 / 10_000) as u64;
        let net_sol_amount = sol_amount - creator_fee;

        // Calculate tokens out using net amount after fee
        let tokens_out = calculate_tokens_out(
            token_state.virtual_sol_reserve,
            token_state.virtual_token_reserve,
            net_sol_amount,
        )?;

        require!(tokens_out >= min_tokens_out, LaunchpadError::SlippageExceeded);
        require!(tokens_out <= token_state.real_token_reserve, LaunchpadError::InsufficientLiquidity);

        // Transfer net SOL from buyer to sol_vault
        anchor_lang::system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.key(),
                anchor_lang::system_program::Transfer {
                    from: ctx.accounts.user.to_account_info(),
                    to: ctx.accounts.sol_vault.to_account_info(),
                },
            ),
            net_sol_amount,
        )?;

        // Transfer creator fee from buyer to fee_escrow PDA
        if creator_fee > 0 {
            anchor_lang::system_program::transfer(
                CpiContext::new(
                    ctx.accounts.system_program.key(),
                    anchor_lang::system_program::Transfer {
                        from: ctx.accounts.user.to_account_info(),
                        to: ctx.accounts.fee_escrow.to_account_info(),
                    },
                ),
                creator_fee,
            )?;
        }

        // Transfer tokens from vault to buyer
        let mint_key = token_state.mint;
        let seeds = &[b"sol_vault", mint_key.as_ref(), &[token_state.vault_bump]];
        let signer_seeds = &[&seeds[..]];

        let cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.key(),
            Transfer {
                from: ctx.accounts.token_vault.to_account_info(),
                to: ctx.accounts.user_token_account.to_account_info(),
                authority: ctx.accounts.sol_vault.to_account_info(),
            },
            signer_seeds,
        );
        token::transfer(cpi_ctx, tokens_out)?;

        // Update reserves (using net amount — fee is not part of bonding curve)
        token_state.virtual_sol_reserve += net_sol_amount;
        token_state.virtual_token_reserve -= tokens_out;
        token_state.real_sol_reserve += net_sol_amount;
        token_state.real_token_reserve -= tokens_out;
        token_state.sol_raised += net_sol_amount;
        token_state.tokens_sold += tokens_out;
        token_state.creator_fees_accumulated += creator_fee;

        emit!(TradeEvent {
            mint: token_state.mint,
            trader: ctx.accounts.user.key(),
            trade_type: TradeType::Buy,
            sol_amount,
            token_amount: tokens_out,
            virtual_sol_reserve: token_state.virtual_sol_reserve,
            virtual_token_reserve: token_state.virtual_token_reserve,
            timestamp: Clock::get()?.unix_timestamp,
        });

        // Same-transaction graduation when this buy crosses the threshold (no second tx).
        if token_state.sol_raised >= GRADUATION_THRESHOLD_LAMPORTS {
            let vault_bump = token_state.vault_bump;
            let platform = &mut ctx.accounts.platform;
            graduate_token_now(
                token_state,
                platform,
                &ctx.accounts.mint,
                &ctx.accounts.mint_authority.to_account_info(),
                &ctx.accounts.sol_vault.to_account_info(),
                &ctx.accounts.platform_fee_recipient.to_account_info(),
                &ctx.accounts.gamm_pool_placeholder.to_account_info(),
                &ctx.accounts.system_program,
                &ctx.accounts.token_program,
                ctx.bumps.mint_authority,
                vault_bump,
            )?;
        }

        Ok(())
    }

    /// Sell tokens back to the bonding curve.
    pub fn sell(ctx: Context<Trade>, token_amount: u64, min_sol_out: u64) -> Result<()> {
        let token_state = &mut ctx.accounts.token_state;

        require!(token_state.phase == TokenPhase::Bonding, LaunchpadError::NotOnBondingCurve);
        require!(token_amount > 0, LaunchpadError::ZeroAmount);

        // Calculate SOL out
        // sol_out = virtual_sol_reserve * tokens_in / (virtual_token_reserve + tokens_in)
        let sol_out = calculate_sol_out(
            token_state.virtual_sol_reserve,
            token_state.virtual_token_reserve,
            token_amount,
        )?;

        require!(sol_out >= min_sol_out, LaunchpadError::SlippageExceeded);
        require!(sol_out <= token_state.real_sol_reserve, LaunchpadError::InsufficientLiquidity);

        // Keep `sol_vault` rent-exempt: payout must leave at least the 0-data rent minimum.
        let rent_min = sol_vault_rent_exempt_min()?;
        let vault_lamports = ctx.accounts.sol_vault.lamports();
        let lamports_after = vault_lamports
            .checked_sub(sol_out)
            .ok_or(LaunchpadError::MathOverflow)?;
        require!(lamports_after >= rent_min, LaunchpadError::InsufficientLiquidity);

        // Transfer tokens from seller to vault (burn mechanism)
        let cpi_ctx = CpiContext::new(
            ctx.accounts.token_program.key(),
            Transfer {
                from: ctx.accounts.user_token_account.to_account_info(),
                to: ctx.accounts.token_vault.to_account_info(),
                authority: ctx.accounts.user.to_account_info(),
            },
        );
        token::transfer(cpi_ctx, token_amount)?;

        // Transfer SOL from vault to seller via PDA-signed CPI
        let mint_key = token_state.mint;
        let seeds = &[b"sol_vault", mint_key.as_ref(), &[token_state.vault_bump]];
        let signer_seeds = &[&seeds[..]];

        anchor_lang::system_program::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.system_program.key(),
                anchor_lang::system_program::Transfer {
                    from: ctx.accounts.sol_vault.to_account_info(),
                    to: ctx.accounts.user.to_account_info(),
                },
                signer_seeds,
            ),
            sol_out,
        )?;

        // Update reserves
        token_state.virtual_sol_reserve -= sol_out;
        token_state.virtual_token_reserve += token_amount;
        token_state.real_sol_reserve -= sol_out;
        token_state.real_token_reserve += token_amount;
        token_state.sol_raised -= sol_out;
        token_state.tokens_sold -= token_amount;

        emit!(TradeEvent {
            mint: token_state.mint,
            trader: ctx.accounts.user.key(),
            trade_type: TradeType::Sell,
            sol_amount: sol_out,
            token_amount,
            virtual_sol_reserve: token_state.virtual_sol_reserve,
            virtual_token_reserve: token_state.virtual_token_reserve,
            timestamp: Clock::get()?.unix_timestamp,
        });

        Ok(())
    }

    /// Graduate the token: revoke mint authority, record GAMM placeholder.
    /// Normally completes inside `buy` in the same transaction as the threshold-crossing trade.
    /// Kept for legacy `ReadyToGraduate` accounts and recovery if a client skipped accounts.
    pub fn graduate(ctx: Context<Graduate>) -> Result<()> {
        let token_state = &mut ctx.accounts.token_state;

        require!(
            token_state.phase != TokenPhase::Graduated,
            LaunchpadError::AlreadyGraduated
        );
        require!(
            token_state.phase == TokenPhase::ReadyToGraduate
                || (token_state.phase == TokenPhase::Bonding
                    && token_state.sol_raised >= GRADUATION_THRESHOLD_LAMPORTS),
            LaunchpadError::NotReadyToGraduate
        );

        let vault_bump = token_state.vault_bump;
        let platform = &mut ctx.accounts.platform;
        graduate_token_now(
            token_state,
            platform,
            &ctx.accounts.mint,
            &ctx.accounts.mint_authority.to_account_info(),
            &ctx.accounts.sol_vault.to_account_info(),
            &ctx.accounts.platform_fee_recipient.to_account_info(),
            &ctx.accounts.gamm_pool_placeholder.to_account_info(),
            &ctx.accounts.system_program,
            &ctx.accounts.token_program,
            ctx.bumps.mint_authority,
            vault_bump,
        )?;

        Ok(())
    }

    /// Claim accumulated creator royalties from a graduated GAMM pool.
    /// In production, this proxies to the Omnipair claim instruction.
    pub fn claim_creator_fees(ctx: Context<ClaimFees>) -> Result<()> {
        let token_state = &mut ctx.accounts.token_state;

        require!(token_state.phase == TokenPhase::Graduated, LaunchpadError::NotGraduated);
        require!(
            ctx.accounts.claimer.key() == token_state.creator_fee_recipient
                || ctx.accounts.claimer.key() == token_state.creator,
            LaunchpadError::Unauthorized
        );
        require!(token_state.creator_fees_accumulated > 0, LaunchpadError::NothingToClaim);

        let amount = token_state.creator_fees_accumulated;
        token_state.creator_fees_accumulated = 0;

        // Transfer from fee escrow to claimer via PDA-signed CPI
        // In production: CPI to Omnipair's claim instruction
        let mint_key = token_state.mint;
        let escrow_seeds = &[b"fee_escrow", mint_key.as_ref(), &[ctx.bumps.fee_escrow]];

        anchor_lang::system_program::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.system_program.key(),
                anchor_lang::system_program::Transfer {
                    from: ctx.accounts.fee_escrow.to_account_info(),
                    to: ctx.accounts.claimer.to_account_info(),
                },
                &[escrow_seeds],
            ),
            amount,
        )?;

        emit!(FeesClaimed {
            mint: token_state.mint,
            claimer: ctx.accounts.claimer.key(),
            amount,
            timestamp: Clock::get()?.unix_timestamp,
        });

        Ok(())
    }

    /// After graduation, move `sol_vault` SOL + a **calculated** slice of `token_vault` into the
    /// `deployer` WSOL / token ATAs, then CPI Omnipair `initialize`. On success, sets
    /// `token_state.gamm_pool` to the new pair PDA.
    ///
    /// **Pump-style pricing (vs old behavior):** Previously we moved **all** spendable SOL and **all**
    /// vault tokens into Omnipair, so the pool ratio was `SOL / full_vault_balance`, which is **far below**
    /// the terminal bonding-curve spot (virtual_sol/virtual_token) and diluted the post-migration price.
    /// Now we deposit `spendable_lamports` and exactly `token_amount_for_pool` such that
    /// `token_amount_for_pool / spendable_lamports ≈ virtual_token_reserve / virtual_sol_reserve`, then
    /// **burn** the vault remainder so excess supply does not enter the pool.
    ///
    /// **Client responsibilities:** append `remaining_accounts` in Omnipair IDL order (25 accounts),
    /// fund `deployer` with ~0.2 SOL + rent for Omnipair pair creation fee and new accounts, pass an
    /// empty `lp_mint` account (82 bytes, uninitialized), and use canonical mint order `token0 < token1`.
    pub fn bootstrap_omnipair_pool(
        ctx: Context<BootstrapOmnipairPool>,
        config: OmnipairPoolConfigArgs,
    ) -> Result<()> {
        let token_state = &mut ctx.accounts.token_state;
        require!(
            token_state.phase == TokenPhase::Graduated,
            LaunchpadError::NotGraduated
        );
        require_keys_eq!(
            token_state.gamm_pool,
            Pubkey::default(),
            LaunchpadError::GammPoolAlreadyLinked
        );
        require_keys_eq!(token_state.mint, ctx.accounts.mint.key(), LaunchpadError::InvalidMint);
        require!(
            omnipair_params_hash_matches(&config),
            LaunchpadError::InvalidOmnipairParamsHash
        );
        require!(config.lp_uri.starts_with("http"), LaunchpadError::InvalidLpUri);
        require!(config.lp_name.len() <= 32, LaunchpadError::InvalidLpName);
        require!(config.lp_symbol.len() <= 10, LaunchpadError::InvalidLpSymbol);

        let rem = ctx.remaining_accounts;
        require!(
            rem.len() == OMNIPAIR_INITIALIZE_ACCOUNT_LEN,
            LaunchpadError::OmnipairAccountCount
        );

        require_keys_eq!(rem[0].key(), ctx.accounts.deployer.key(), LaunchpadError::OmnipairAccounts);
        let token0 = rem[1].key();
        let token1 = rem[2].key();
        require!(token0 < token1, LaunchpadError::OmnipairTokenOrder);

        let wsol = anchor_spl::token::spl_token::native_mint::ID;
        require!(
            (token0 == wsol && token1 == ctx.accounts.mint.key())
                || (token0 == ctx.accounts.mint.key() && token1 == wsol),
            LaunchpadError::OmnipairMintMismatch
        );

        let (expected_pair, _) = Pubkey::find_program_address(
            &[b"gamm_pair", token0.as_ref(), token1.as_ref(), config.params_hash.as_ref()],
            &OMNIPAIR_PROGRAM_ID,
        );
        require_keys_eq!(rem[3].key(), expected_pair, LaunchpadError::OmnipairInvalidPair);

        let (expected_fa, _) =
            Pubkey::find_program_address(&[b"futarchy_authority"], &OMNIPAIR_PROGRAM_ID);
        require_keys_eq!(rem[4].key(), expected_fa, LaunchpadError::OmnipairInvalidFutarchy);

        let (expected_ea, _) =
            Pubkey::find_program_address(&[b"__event_authority"], &OMNIPAIR_PROGRAM_ID);
        require_keys_eq!(rem[23].key(), expected_ea, LaunchpadError::OmnipairInvalidEventAuthority);
        require_keys_eq!(rem[24].key(), OMNIPAIR_PROGRAM_ID, LaunchpadError::OmnipairInvalidProgram);

        require_keys_eq!(rem[17].key(), System::id(), LaunchpadError::OmnipairAccounts);
        require_keys_eq!(rem[18].key(), Token::id(), LaunchpadError::OmnipairAccounts);
        require_keys_eq!(rem[19].key(), TOKEN_2022_PROGRAM_ID, LaunchpadError::OmnipairAccounts);
        require_keys_eq!(rem[20].key(), MPL_TOKEN_METADATA_ID, LaunchpadError::OmnipairAccounts);
        require_keys_eq!(
            rem[21].key(),
            anchor_spl::associated_token::ID,
            LaunchpadError::OmnipairAccounts
        );
        require_keys_eq!(rem[22].key(), Rent::id(), LaunchpadError::OmnipairAccounts);

        let expected_dt0 =
            anchor_spl::associated_token::get_associated_token_address(&rem[0].key(), &token0);
        let expected_dt1 =
            anchor_spl::associated_token::get_associated_token_address(&rem[0].key(), &token1);
        require_keys_eq!(rem[13].key(), expected_dt0, LaunchpadError::OmnipairDeployerAtas);
        require_keys_eq!(rem[14].key(), expected_dt1, LaunchpadError::OmnipairDeployerAtas);

        let deployer_pk = ctx.accounts.deployer.key();
        let expected_wsol_ata =
            anchor_spl::associated_token::get_associated_token_address(&deployer_pk, &wsol);
        let expected_project_ata =
            anchor_spl::associated_token::get_associated_token_address(&deployer_pk, &ctx.accounts.mint.key());
        require_keys_eq!(
            ctx.accounts.deployer_wsol.key(),
            expected_wsol_ata,
            LaunchpadError::OmnipairDeployerAtas
        );
        require_keys_eq!(
            ctx.accounts.deployer_token.key(),
            expected_project_ata,
            LaunchpadError::OmnipairDeployerAtas
        );

        let rent_min = sol_vault_rent_exempt_min()?;
        let vault_lamports = ctx.accounts.sol_vault.lamports();
        let spendable_lamports = vault_lamports
            .checked_sub(rent_min)
            .ok_or(LaunchpadError::MathOverflow)?;

        let v_sol = token_state.virtual_sol_reserve;
        let v_token = token_state.virtual_token_reserve;
        let initial_vault_tokens = ctx.accounts.token_vault.amount;

        require!(spendable_lamports > 0, LaunchpadError::InsufficientLiquidity);
        require!(initial_vault_tokens > 0, LaunchpadError::InsufficientLiquidity);
        require!(v_sol > 0 && v_token > 0, LaunchpadError::MathOverflow);

        // Terminal bonding spot (raw): virtual_token / virtual_sol → pool token amount for this SOL.
        let token_amount_for_pool =
            token_amount_for_omnipair_at_terminal_price(spendable_lamports, v_sol, v_token)?;
        require!(token_amount_for_pool > 0, LaunchpadError::InsufficientLiquidity);
        require!(
            token_amount_for_pool <= initial_vault_tokens,
            LaunchpadError::BootstrapPoolTokenMismatch
        );

        let leftover_burn = initial_vault_tokens
            .checked_sub(token_amount_for_pool)
            .ok_or(LaunchpadError::MathOverflow)?;

        msg!(
            "bootstrap_omnipair_pool: spendable_lamports={} token_for_pool={} vault_before={} leftover_burn={} v_sol={} v_token={}",
            spendable_lamports,
            token_amount_for_pool,
            initial_vault_tokens,
            leftover_burn,
            v_sol,
            v_token
        );

        let (amount0_in, amount1_in) = if token0 == wsol {
            (spendable_lamports, token_amount_for_pool)
        } else {
            (token_amount_for_pool, spendable_lamports)
        };

        let mint_key = token_state.mint;
        let vault_seeds: &[&[u8]] = &[b"sol_vault", mint_key.as_ref(), &[token_state.vault_bump]];
        let signer_seeds: &[&[&[u8]]] = &[vault_seeds];

        anchor_lang::system_program::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.system_program.key(),
                anchor_lang::system_program::Transfer {
                    from: ctx.accounts.sol_vault.to_account_info(),
                    to: ctx.accounts.deployer_wsol.to_account_info(),
                },
                signer_seeds,
            ),
            spendable_lamports,
        )?;

        let sync_ix = anchor_spl::token::spl_token::instruction::sync_native(
            &ctx.accounts.token_program.key(),
            &ctx.accounts.deployer_wsol.key(),
        )?;
        invoke(
            &sync_ix,
            &[
                ctx.accounts.deployer_wsol.to_account_info(),
                ctx.accounts.token_program.to_account_info(),
            ],
        )?;

        let xfer_tokens = CpiContext::new_with_signer(
            ctx.accounts.token_program.key(),
            Transfer {
                from: ctx.accounts.token_vault.to_account_info(),
                to: ctx.accounts.deployer_token.to_account_info(),
                authority: ctx.accounts.sol_vault.to_account_info(),
            },
            signer_seeds,
        );
        token::transfer(xfer_tokens, token_amount_for_pool)?;

        // Burn vault remainder: `sol_vault` PDA is the token_vault authority (same signer as transfers).
        if leftover_burn > 0 {
            let burn_ctx = CpiContext::new_with_signer(
                ctx.accounts.token_program.key(),
                Burn {
                    mint: ctx.accounts.mint.to_account_info(),
                    from: ctx.accounts.token_vault.to_account_info(),
                    authority: ctx.accounts.sol_vault.to_account_info(),
                },
                signer_seeds,
            );
            token::burn(burn_ctx, leftover_burn)?;
            msg!(
                "bootstrap_omnipair_pool: burned {} leftover project tokens from bonding vault",
                leftover_burn
            );
        }

        let ix_data = build_omnipair_initialize_ix_data(&config, amount0_in, amount1_in)?;
        let omnipair_ix = Instruction {
            program_id: OMNIPAIR_PROGRAM_ID,
            accounts: rem
                .iter()
                .map(|a| {
                    anchor_lang::solana_program::instruction::AccountMeta {
                        pubkey: a.key(),
                        is_signer: a.is_signer,
                        is_writable: a.is_writable,
                    }
                })
                .collect(),
            data: ix_data,
        };
        invoke(&omnipair_ix, rem)?;

        token_state.gamm_pool = expected_pair;
        token_state.real_sol_reserve = 0;
        token_state.real_token_reserve = 0;

        emit!(OmnipairPoolBootstrapped {
            mint: token_state.mint,
            pair: expected_pair,
            deployer: deployer_pk,
            amount0_in,
            amount1_in,
            tokens_burned: leftover_burn,
            timestamp: Clock::get()?.unix_timestamp,
        });

        Ok(())
    }
}

/// Tokens to pair with `spendable_lamports` so pool ratio matches terminal bonding spot
/// `virtual_token / virtual_sol` (same units as the constant-product curve state).
fn token_amount_for_omnipair_at_terminal_price(
    spendable_lamports: u64,
    virtual_sol: u64,
    virtual_token: u64,
) -> Result<u64> {
    let num = (spendable_lamports as u128)
        .checked_mul(virtual_token as u128)
        .ok_or(LaunchpadError::MathOverflow)?;
    let out = num
        .checked_div(virtual_sol as u128)
        .ok_or(LaunchpadError::MathOverflow)?;
    u64::try_from(out).map_err(|_| error!(LaunchpadError::MathOverflow))
}

// ─── Math helpers ──────────────────────────────────────────────────────────────

/// Constant-product tokens out: Δtoken = token_reserve * Δsol / (sol_reserve + Δsol)
pub fn calculate_tokens_out(
    virtual_sol: u64,
    virtual_tokens: u64,
    sol_in: u64,
) -> Result<u64> {
    let k = (virtual_sol as u128)
        .checked_mul(virtual_tokens as u128)
        .ok_or(LaunchpadError::MathOverflow)?;
    let new_sol = (virtual_sol as u128)
        .checked_add(sol_in as u128)
        .ok_or(LaunchpadError::MathOverflow)?;
    let new_tokens = k
        .checked_div(new_sol)
        .ok_or(LaunchpadError::MathOverflow)?;
    let tokens_out = (virtual_tokens as u128)
        .checked_sub(new_tokens)
        .ok_or(LaunchpadError::MathOverflow)?;
    Ok(tokens_out as u64)
}

/// Constant-product SOL out: Δsol = sol_reserve * Δtoken / (token_reserve + Δtoken)
pub fn calculate_sol_out(
    virtual_sol: u64,
    virtual_tokens: u64,
    tokens_in: u64,
) -> Result<u64> {
    let k = (virtual_sol as u128)
        .checked_mul(virtual_tokens as u128)
        .ok_or(LaunchpadError::MathOverflow)?;
    let new_tokens = (virtual_tokens as u128)
        .checked_add(tokens_in as u128)
        .ok_or(LaunchpadError::MathOverflow)?;
    let new_sol = k
        .checked_div(new_tokens)
        .ok_or(LaunchpadError::MathOverflow)?;
    let sol_out = (virtual_sol as u128)
        .checked_sub(new_sol)
        .ok_or(LaunchpadError::MathOverflow)?;
    Ok(sol_out as u64)
}

// ─── Accounts ─────────────────────────────────────────────────────────────────

#[derive(Accounts)]
pub struct InitializePlatform<'info> {
    #[account(
        init,
        payer = authority,
        space = 8 + PlatformState::INIT_SPACE,
        seeds = [b"platform"],
        bump
    )]
    pub platform: Account<'info, PlatformState>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(params: CreateTokenParams)]
pub struct CreateToken<'info> {
    #[account(
        init,
        payer = creator,
        space = 8 + TokenState::INIT_SPACE,
        seeds = [b"token_state", mint.key().as_ref()],
        bump
    )]
    pub token_state: Account<'info, TokenState>,

    #[account(
        init,
        payer = creator,
        mint::decimals = TOKEN_DECIMALS,
        mint::authority = mint_authority,
    )]
    pub mint: Account<'info, Mint>,

    /// PDA that holds mint authority (revoked at graduation)
    #[account(
        seeds = [b"mint_authority", mint.key().as_ref()],
        bump
    )]
    pub mint_authority: SystemAccount<'info>,

    /// CHECK: System-owned 0-byte PDA vault; `init` funds rent-exempt minimum only — tradable SOL is `real_sol_reserve`.
    #[account(
        init,
        payer = creator,
        space = 0,
        seeds = [b"sol_vault", mint.key().as_ref()],
        bump,
        owner = anchor_lang::solana_program::system_program::ID,
    )]
    pub sol_vault: UncheckedAccount<'info>,

    /// Token vault holding all 10M tokens
    #[account(
        init,
        payer = creator,
        associated_token::mint = mint,
        associated_token::authority = sol_vault,
    )]
    pub token_vault: Account<'info, TokenAccount>,

    /// CHECK: Metaplex metadata account, validated by CPI
    #[account(mut)]
    pub metadata: UncheckedAccount<'info>,

    #[account(mut, seeds = [b"platform"], bump = platform.bump)]
    pub platform: Account<'info, PlatformState>,

    #[account(mut)]
    pub creator: Signer<'info>,

    pub rent: Sysvar<'info, Rent>,
    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub metadata_program: Program<'info, Metadata>,
}

#[derive(Accounts)]
pub struct Trade<'info> {
    #[account(
        mut,
        seeds = [b"token_state", token_state.mint.as_ref()],
        bump = token_state.bump
    )]
    pub token_state: Account<'info, TokenState>,

    #[account(mut)]
    pub mint: Account<'info, Mint>,

    #[account(
        mut,
        seeds = [b"sol_vault", token_state.mint.as_ref()],
        bump = token_state.vault_bump
    )]
    pub sol_vault: SystemAccount<'info>,

    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = sol_vault,
    )]
    pub token_vault: Account<'info, TokenAccount>,

    #[account(
        init_if_needed,
        payer = user,
        associated_token::mint = mint,
        associated_token::authority = user,
    )]
    pub user_token_account: Account<'info, TokenAccount>,

    #[account(mut)]
    pub user: Signer<'info>,

    /// Fee escrow PDA — receives creator fees during buy
    #[account(
        mut,
        seeds = [b"fee_escrow", token_state.mint.as_ref()],
        bump
    )]
    pub fee_escrow: SystemAccount<'info>,

    /// Mint authority PDA — revoked in the same transaction when a buy crosses graduation.
    #[account(
        mut,
        seeds = [b"mint_authority", mint.key().as_ref()],
        bump
    )]
    pub mint_authority: SystemAccount<'info>,

    #[account(mut, seeds = [b"platform"], bump = platform.bump)]
    pub platform: Account<'info, PlatformState>,

    /// CHECK: Must match `platform.fee_recipient` (validated in `graduate_token_now` when graduation runs).
    #[account(mut)]
    pub platform_fee_recipient: UncheckedAccount<'info>,

    /// CHECK: Omnipair pool placeholder until Omnipair CPI is wired.
    pub gamm_pool_placeholder: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
}

#[derive(Accounts)]
pub struct Graduate<'info> {
    #[account(
        mut,
        seeds = [b"token_state", token_state.mint.as_ref()],
        bump = token_state.bump
    )]
    pub token_state: Account<'info, TokenState>,

    #[account(mut)]
    pub mint: Account<'info, Mint>,

    /// PDA holding mint authority — will be stripped of authority
    #[account(
        mut,
        seeds = [b"mint_authority", mint.key().as_ref()],
        bump
    )]
    pub mint_authority: SystemAccount<'info>,

    #[account(
        mut,
        seeds = [b"sol_vault", token_state.mint.as_ref()],
        bump = token_state.vault_bump
    )]
    pub sol_vault: SystemAccount<'info>,

    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = sol_vault,
    )]
    pub token_vault: Account<'info, TokenAccount>,

    /// CHECK: Platform fee recipient
    #[account(mut)]
    pub platform_fee_recipient: UncheckedAccount<'info>,

    /// CHECK: Omnipair GAMM pool account (initialized via CPI in production)
    pub gamm_pool_placeholder: UncheckedAccount<'info>,

    #[account(mut, seeds = [b"platform"], bump = platform.bump)]
    pub platform: Account<'info, PlatformState>,

    #[account(mut)]
    pub caller: Signer<'info>,

    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
}

#[derive(Accounts)]
pub struct ClaimFees<'info> {
    #[account(
        mut,
        seeds = [b"token_state", token_state.mint.as_ref()],
        bump = token_state.bump
    )]
    pub token_state: Account<'info, TokenState>,

    /// CHECK: Fee escrow — in production this is the Omnipair fee accumulator
    #[account(mut, seeds = [b"fee_escrow", token_state.mint.as_ref()], bump)]
    pub fee_escrow: UncheckedAccount<'info>,

    #[account(mut)]
    pub claimer: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct BootstrapOmnipairPool<'info> {
    #[account(
        mut,
        seeds = [b"token_state", token_state.mint.as_ref()],
        bump = token_state.bump
    )]
    pub token_state: Account<'info, TokenState>,

    #[account(mut, address = token_state.mint)]
    pub mint: Account<'info, Mint>,

    #[account(
        mut,
        seeds = [b"sol_vault", token_state.mint.as_ref()],
        bump = token_state.vault_bump
    )]
    pub sol_vault: SystemAccount<'info>,

    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = sol_vault,
    )]
    pub token_vault: Account<'info, TokenAccount>,

    #[account(mut)]
    pub deployer: Signer<'info>,

    /// Native SOL wrapped mint (So111...).
    #[account(address = anchor_spl::token::spl_token::native_mint::ID)]
    pub wsol_mint: Account<'info, Mint>,

    #[account(
        init_if_needed,
        payer = deployer,
        associated_token::mint = wsol_mint,
        associated_token::authority = deployer,
    )]
    pub deployer_wsol: Account<'info, TokenAccount>,

    #[account(
        init_if_needed,
        payer = deployer,
        associated_token::mint = mint,
        associated_token::authority = deployer,
    )]
    pub deployer_token: Account<'info, TokenAccount>,

    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
}

// ─── State accounts ────────────────────────────────────────────────────────────

#[account]
#[derive(InitSpace)]
pub struct PlatformState {
    pub authority: Pubkey,
    pub fee_recipient: Pubkey,
    pub total_tokens_created: u64,
    pub total_sol_raised: u64,
    pub total_graduated: u64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct TokenState {
    pub mint: Pubkey,
    pub creator: Pubkey,
    pub creator_fee_recipient: Pubkey,
    #[max_len(32)]
    pub name: String,
    #[max_len(10)]
    pub symbol: String,
    #[max_len(200)]
    pub uri: String,
    pub created_at: i64,
    pub phase: TokenPhase,

    // Bonding curve reserves (virtual + real)
    pub virtual_sol_reserve: u64,
    pub virtual_token_reserve: u64,
    pub real_sol_reserve: u64,
    pub real_token_reserve: u64,

    // Cumulative stats
    pub sol_raised: u64,
    pub tokens_sold: u64,
    pub total_supply: u64,

    // Post-graduation
    pub gamm_pool: Pubkey,
    pub creator_fees_accumulated: u64,

    pub bump: u8,
    pub vault_bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, InitSpace)]
pub enum TokenPhase {
    Bonding,
    /// Legacy / edge case: older deployments stopped here before `graduate`. New buys finish in `Graduated` same-tx.
    ReadyToGraduate,
    Graduated,
}

// ─── Instruction params ────────────────────────────────────────────────────────

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct CreateTokenParams {
    pub name: String,
    pub symbol: String,
    pub uri: String,  // IPFS/Arweave metadata JSON URI
    pub creator_fee_recipient: Pubkey,
}

// ─── Events ────────────────────────────────────────────────────────────────────

#[event]
pub struct TokenCreated {
    pub mint: Pubkey,
    pub creator: Pubkey,
    pub creator_fee_recipient: Pubkey,
    pub name: String,
    pub symbol: String,
    pub timestamp: i64,
}

#[event]
pub struct TradeEvent {
    pub mint: Pubkey,
    pub trader: Pubkey,
    pub trade_type: TradeType,
    pub sol_amount: u64,
    pub token_amount: u64,
    pub virtual_sol_reserve: u64,
    pub virtual_token_reserve: u64,
    pub timestamp: i64,
}

#[event]
pub struct GraduationReady {
    pub mint: Pubkey,
}

#[event]
pub struct TokenGraduated {
    pub mint: Pubkey,
    pub creator: Pubkey,
    pub sol_raised: u64,
    pub gamm_pool: Pubkey,
    pub timestamp: i64,
}

#[event]
pub struct FeesClaimed {
    pub mint: Pubkey,
    pub claimer: Pubkey,
    pub amount: u64,
    pub timestamp: i64,
}

#[event]
pub struct OmnipairPoolBootstrapped {
    pub mint: Pubkey,
    pub pair: Pubkey,
    pub deployer: Pubkey,
    pub amount0_in: u64,
    pub amount1_in: u64,
    /// Project tokens burned from the bonding `token_vault` after seeding Omnipair (excess supply).
    pub tokens_burned: u64,
    pub timestamp: i64,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub enum TradeType {
    Buy,
    Sell,
}

/// Shared graduation: platform fee from `sol_vault`, revoke mint authority, `phase = Graduated`.
///
/// **Omnipair:** Pool creation is **not** done here — same-tx graduation only revokes mint authority and
/// sets `gamm_pool` from the client placeholder. After graduation, call **`bootstrap_omnipair_pool`**
/// (see `program/OMNIPAIR_INTEGRATION.md`) to CPI Omnipair `initialize` and persist the real pair PDA.
fn graduate_token_now<'info>(
    token_state: &mut TokenState,
    platform: &mut PlatformState,
    mint: &Account<'info, Mint>,
    mint_authority: &AccountInfo<'info>,
    sol_vault: &AccountInfo<'info>,
    platform_fee_recipient: &AccountInfo<'info>,
    gamm_pool_placeholder: &AccountInfo<'info>,
    system_program: &Program<'info, System>,
    token_program: &Program<'info, Token>,
    mint_authority_bump: u8,
    vault_bump: u8,
) -> Result<()> {
    require!(
        token_state.phase != TokenPhase::Graduated,
        LaunchpadError::AlreadyGraduated
    );
    require_keys_eq!(
        token_state.mint,
        mint.key(),
        LaunchpadError::InvalidMint
    );
    require_keys_eq!(
        platform_fee_recipient.key(),
        platform.fee_recipient,
        LaunchpadError::InvalidPlatformFeeRecipient
    );

    let platform_fee =
        (token_state.real_sol_reserve as u128 * PLATFORM_FEE_BPS as u128 / 10_000) as u64;

    let rent_min = sol_vault_rent_exempt_min()?;
    let lamports_after_fee = sol_vault
        .lamports()
        .checked_sub(platform_fee)
        .ok_or(LaunchpadError::MathOverflow)?;
    require!(lamports_after_fee >= rent_min, LaunchpadError::InsufficientLiquidity);

    let mint_key = token_state.mint;
    let vault_seeds = &[b"sol_vault", mint_key.as_ref(), &[vault_bump]];

    anchor_lang::system_program::transfer(
        CpiContext::new_with_signer(
            system_program.key(),
            anchor_lang::system_program::Transfer {
                from: sol_vault.clone(),
                to: platform_fee_recipient.clone(),
            },
            &[vault_seeds],
        ),
        platform_fee,
    )?;

    let auth_seeds = &[b"mint_authority", mint_key.as_ref(), &[mint_authority_bump]];
    let signer_seeds = &[&auth_seeds[..]];

    let cpi_ctx = CpiContext::new_with_signer(
        token_program.key(),
        SetAuthority {
            account_or_mint: mint.to_account_info(),
            current_authority: mint_authority.clone(),
        },
        signer_seeds,
    );
    token::set_authority(cpi_ctx, AuthorityType::MintTokens, None)?;

    token_state.phase = TokenPhase::Graduated;
    token_state.gamm_pool = gamm_pool_placeholder.key();

    platform.total_graduated = platform
        .total_graduated
        .checked_add(1)
        .ok_or(LaunchpadError::MathOverflow)?;
    platform.total_sol_raised = platform
        .total_sol_raised
        .checked_add(token_state.sol_raised)
        .ok_or(LaunchpadError::MathOverflow)?;

    emit!(TokenGraduated {
        mint: token_state.mint,
        creator: token_state.creator,
        sol_raised: token_state.sol_raised,
        gamm_pool: token_state.gamm_pool,
        timestamp: Clock::get()?.unix_timestamp,
    });

    Ok(())
}

// ─── Errors ────────────────────────────────────────────────────────────────────

#[error_code]
pub enum LaunchpadError {
    #[msg("Token name exceeds 32 characters")]
    NameTooLong,
    #[msg("Symbol exceeds 10 characters")]
    SymbolTooLong,
    #[msg("URI exceeds 200 characters")]
    UriTooLong,
    #[msg("Token is not on the bonding curve")]
    NotOnBondingCurve,
    #[msg("Amount must be greater than zero")]
    ZeroAmount,
    #[msg("Slippage tolerance exceeded")]
    SlippageExceeded,
    #[msg("Insufficient liquidity in pool")]
    InsufficientLiquidity,
    #[msg("Token has not reached graduation threshold")]
    NotReadyToGraduate,
    #[msg("Token has not graduated yet")]
    NotGraduated,
    #[msg("Nothing to claim")]
    NothingToClaim,
    #[msg("Unauthorized: not the creator or fee recipient")]
    Unauthorized,
    #[msg("Math overflow")]
    MathOverflow,
    #[msg("Token has already graduated")]
    AlreadyGraduated,
    #[msg("Mint account does not match token state")]
    InvalidMint,
    #[msg("Platform fee recipient must match platform.fee_recipient")]
    InvalidPlatformFeeRecipient,
    #[msg("GAMM pool is already linked (gamm_pool is non-default)")]
    GammPoolAlreadyLinked,
    #[msg("Invalid Omnipair params hash for pool configuration")]
    InvalidOmnipairParamsHash,
    #[msg("LP metadata URI must start with http:// or https://")]
    InvalidLpUri,
    #[msg("LP name invalid or too long")]
    InvalidLpName,
    #[msg("LP symbol invalid or too long")]
    InvalidLpSymbol,
    #[msg("Wrong number of Omnipair remaining accounts (expected 25)")]
    OmnipairAccountCount,
    #[msg("Omnipair account addresses do not match expected program IDs or PDAs")]
    OmnipairAccounts,
    #[msg("Omnipair token0 must be lexicographically less than token1")]
    OmnipairTokenOrder,
    #[msg("Omnipair pair must be project mint + wrapped SOL")]
    OmnipairMintMismatch,
    #[msg("Omnipair pair PDA mismatch")]
    OmnipairInvalidPair,
    #[msg("Omnipair futarchy_authority PDA mismatch")]
    OmnipairInvalidFutarchy,
    #[msg("Omnipair event_authority PDA mismatch")]
    OmnipairInvalidEventAuthority,
    #[msg("Last remaining account must be the Omnipair program id")]
    OmnipairInvalidProgram,
    #[msg("Deployer token accounts must match token0/token1 ATAs")]
    OmnipairDeployerAtas,
    #[msg("Computed Omnipair token deposit exceeds token_vault balance (inconsistent curve state)")]
    BootstrapPoolTokenMismatch,
}
