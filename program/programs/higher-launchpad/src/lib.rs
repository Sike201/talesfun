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
use spl_token::instruction::AuthorityType;

declare_id!("HiGHrLaunchPadXXXXXXXXXXXXXXXXXXXXXXXXXXXXX");

// ─── Constants ────────────────────────────────────────────────────────────────

/// Every token has exactly 10,000,000 units (with 6 decimals = 10_000_000_000_000 raw)
pub const FIXED_SUPPLY: u64 = 10_000_000_000_000; // 10M * 10^6
pub const FIXED_SUPPLY_UI: u64 = 10_000_000;
pub const TOKEN_DECIMALS: u8 = 6;

/// Graduation threshold: 85 SOL raised (in lamports)
pub const GRADUATION_THRESHOLD_LAMPORTS: u64 = 85_000_000_000; // 85 SOL

/// Creator fee: 50 bps = 0.5%
pub const CREATOR_FEE_BPS: u16 = 50;

/// LP fee: 50 bps = 0.5%
pub const LP_FEE_BPS: u16 = 50;

/// Total swap fee: 100 bps = 1%
pub const TOTAL_FEE_BPS: u16 = 100;

/// Bonding curve — tokens reserved for bonding curve sales (80% of supply)
pub const BONDING_CURVE_ALLOCATION: u64 = 8_000_000_000_000; // 8M tokens

/// Tokens seeded into GAMM pool at graduation (20% of supply)
pub const GAMM_POOL_ALLOCATION: u64 = 2_000_000_000_000; // 2M tokens

/// Platform fee on graduation: 2% of raised SOL
pub const PLATFORM_FEE_BPS: u16 = 200;

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
        token_state.virtual_token_reserve = BONDING_CURVE_ALLOCATION;
        token_state.real_sol_reserve = 0;
        token_state.real_token_reserve = BONDING_CURVE_ALLOCATION;
        token_state.creator_fees_accumulated = 0;
        token_state.gamm_pool = Pubkey::default();
        token_state.bump = ctx.bumps.token_state;
        token_state.vault_bump = ctx.bumps.sol_vault;

        // Mint full supply to bonding curve token vault
        let cpi_ctx = CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            MintTo {
                mint: ctx.accounts.mint.to_account_info(),
                to: ctx.accounts.token_vault.to_account_info(),
                authority: ctx.accounts.mint_authority.to_account_info(),
            },
        );
        token::mint_to(cpi_ctx, FIXED_SUPPLY)?;

        // Create on-chain metadata via Metaplex
        let seeds = &[b"mint_authority", ctx.accounts.mint.key().as_ref(), &[ctx.bumps.mint_authority]];
        let signer_seeds = &[&seeds[..]];

        create_metadata_accounts_v3(
            CpiContext::new_with_signer(
                ctx.accounts.metadata_program.to_account_info(),
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
    pub fn buy(ctx: Context<Trade>, sol_amount: u64, min_tokens_out: u64) -> Result<()> {
        let token_state = &mut ctx.accounts.token_state;

        require!(token_state.phase == TokenPhase::Bonding, LaunchpadError::NotOnBondingCurve);
        require!(sol_amount > 0, LaunchpadError::ZeroAmount);

        // Calculate tokens out using constant product formula
        // tokens_out = virtual_token_reserve * sol_in / (virtual_sol_reserve + sol_in)
        let tokens_out = calculate_tokens_out(
            token_state.virtual_sol_reserve,
            token_state.virtual_token_reserve,
            sol_amount,
        )?;

        require!(tokens_out >= min_tokens_out, LaunchpadError::SlippageExceeded);
        require!(tokens_out <= token_state.real_token_reserve, LaunchpadError::InsufficientLiquidity);

        // Transfer SOL from buyer to vault
        let cpi_ctx = CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            anchor_lang::system_program::Transfer {
                from: ctx.accounts.user.to_account_info(),
                to: ctx.accounts.sol_vault.to_account_info(),
            },
        );
        anchor_lang::system_program::transfer(cpi_ctx, sol_amount)?;

        // Transfer tokens from vault to buyer
        let mint_key = token_state.mint;
        let seeds = &[b"sol_vault", mint_key.as_ref(), &[token_state.vault_bump]];
        let signer_seeds = &[&seeds[..]];

        let cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.token_vault.to_account_info(),
                to: ctx.accounts.user_token_account.to_account_info(),
                authority: ctx.accounts.sol_vault.to_account_info(),
            },
            signer_seeds,
        );
        token::transfer(cpi_ctx, tokens_out)?;

        // Update reserves
        token_state.virtual_sol_reserve += sol_amount;
        token_state.virtual_token_reserve -= tokens_out;
        token_state.real_sol_reserve += sol_amount;
        token_state.real_token_reserve -= tokens_out;
        token_state.sol_raised += sol_amount;
        token_state.tokens_sold += tokens_out;

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

        // Check graduation trigger
        if token_state.sol_raised >= GRADUATION_THRESHOLD_LAMPORTS {
            token_state.phase = TokenPhase::ReadyToGraduate;
            emit!(GraduationReady { mint: token_state.mint });
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

        // Transfer tokens from seller to vault (burn mechanism)
        let cpi_ctx = CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.user_token_account.to_account_info(),
                to: ctx.accounts.token_vault.to_account_info(),
                authority: ctx.accounts.user.to_account_info(),
            },
        );
        token::transfer(cpi_ctx, token_amount)?;

        // Transfer SOL from vault to seller
        let mint_key = token_state.mint;
        let seeds = &[b"sol_vault", mint_key.as_ref(), &[token_state.vault_bump]];
        let signer_seeds = &[&seeds[..]];

        **ctx.accounts.sol_vault.to_account_info().try_borrow_mut_lamports()? -= sol_out;
        **ctx.accounts.user.to_account_info().try_borrow_mut_lamports()? += sol_out;

        let _ = signer_seeds; // used above conceptually; vault is a PDA

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

    /// Graduate the token: revoke mint authority, seed Omnipair GAMM pool.
    /// Called by anyone once the threshold is reached.
    pub fn graduate(ctx: Context<Graduate>) -> Result<()> {
        let token_state = &mut ctx.accounts.token_state;

        require!(
            token_state.phase == TokenPhase::ReadyToGraduate
                || token_state.sol_raised >= GRADUATION_THRESHOLD_LAMPORTS,
            LaunchpadError::NotReadyToGraduate
        );

        // Platform fee (2% of raised SOL)
        let platform_fee = (token_state.real_sol_reserve as u128 * PLATFORM_FEE_BPS as u128 / 10_000) as u64;
        let sol_for_pool = token_state.real_sol_reserve - platform_fee;

        // Transfer platform fee
        **ctx.accounts.sol_vault.to_account_info().try_borrow_mut_lamports()? -= platform_fee;
        **ctx.accounts.platform_fee_recipient.to_account_info().try_borrow_mut_lamports()? += platform_fee;

        // Revoke mint authority — permanently locks supply at 10M
        let mint_key = token_state.mint;
        let seeds = &[b"mint_authority", mint_key.as_ref(), &[ctx.bumps.mint_authority]];
        let signer_seeds = &[&seeds[..]];

        let cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            SetAuthority {
                account_or_mint: ctx.accounts.mint.to_account_info(),
                current_authority: ctx.accounts.mint_authority.to_account_info(),
            },
            signer_seeds,
        );
        token::set_authority(cpi_ctx, AuthorityType::MintTokens, None)?;

        // ── Omnipair GAMM Integration ──────────────────────────────────────────
        // The Omnipair program is invoked via CPI to:
        //   1. Initialize a new GAMM pool with the token
        //   2. Deposit raised SOL + GAMM_POOL_ALLOCATION tokens as initial liquidity
        //   3. Set 1% swap fee split: 0.5% creator + 0.5% LP
        //
        // NOTE: Replace the omnipair_program address with the real deployed address.
        // Full CPI integration requires the official @omnipair/program-interface IDL.
        //
        // Pseudocode for what this call does:
        //   omnipair::cpi::initialize_pool(
        //     CpiContext::new(...),
        //     InitializePoolParams {
        //       token_mint: ctx.accounts.mint.key(),
        //       initial_sol: sol_for_pool,
        //       initial_tokens: GAMM_POOL_ALLOCATION,
        //       fee_bps: TOTAL_FEE_BPS,               // 100 = 1%
        //       creator_fee_recipient: token_state.creator_fee_recipient,
        //       creator_fee_bps: CREATOR_FEE_BPS,     // 50 = 0.5%
        //     }
        //   )?;
        //
        // For now we record the pool address and mark as graduated.
        // Hook in your Omnipair CPI here once you have the program interface.
        // ──────────────────────────────────────────────────────────────────────

        // Record the graduation
        token_state.phase = TokenPhase::Graduated;
        token_state.gamm_pool = ctx.accounts.gamm_pool_placeholder.key();

        let platform = &mut ctx.accounts.platform;
        platform.total_graduated += 1;
        platform.total_sol_raised += token_state.sol_raised;

        emit!(TokenGraduated {
            mint: token_state.mint,
            creator: token_state.creator,
            sol_raised: token_state.sol_raised,
            gamm_pool: token_state.gamm_pool,
            timestamp: Clock::get()?.unix_timestamp,
        });

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

        // Transfer from fee escrow to claimer
        // In production: CPI to Omnipair's claim instruction
        **ctx.accounts.fee_escrow.to_account_info().try_borrow_mut_lamports()? -= amount;
        **ctx.accounts.claimer.to_account_info().try_borrow_mut_lamports()? += amount;

        emit!(FeesClaimed {
            mint: token_state.mint,
            claimer: ctx.accounts.claimer.key(),
            amount,
            timestamp: Clock::get()?.unix_timestamp,
        });

        Ok(())
    }
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

    /// SOL vault for bonding curve proceeds
    #[account(
        mut,
        seeds = [b"sol_vault", mint.key().as_ref()],
        bump
    )]
    pub sol_vault: SystemAccount<'info>,

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

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub enum TradeType {
    Buy,
    Sell,
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
}
