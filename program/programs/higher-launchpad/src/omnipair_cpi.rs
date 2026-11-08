//! Omnipair `initialize` CPI helpers (raw `invoke`, Anchor 1.0–compatible).
//! Account layout matches `@omnipair/program-interface` IDL `initialize` (program id must match `OMNIPAIR_PROGRAM_ID` in `lib.rs`).

use anchor_lang::prelude::*;
use sha2::{Digest, Sha256};

/// First 8 bytes of `sha256("global:initialize")` for Omnipair (from published IDL).
pub const OMNIPAIR_INITIALIZE_DISCRIMINATOR: [u8; 8] = [175, 175, 109, 31, 13, 152, 155, 237];

/// Number of accounts in Omnipair `initialize` (IDL order).
pub const OMNIPAIR_INITIALIZE_ACCOUNT_LEN: usize = 25;

/// Must match `omnipair::constants::VERSION` (currently1).
pub const OMNIPAIR_PROTOCOL_VERSION: u8 = 1;

/// Pool / IRM parameters passed from the client. Amounts are filled on-chain from vault balances.
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct OmnipairPoolConfigArgs {
    pub swap_fee_bps: u16,
    pub half_life: u64,
    pub fixed_cf_bps: Option<u16>,
    pub target_util_start_bps: Option<u64>,
    pub target_util_end_bps: Option<u64>,
    pub rate_half_life_ms: Option<u64>,
    pub min_rate_bps: Option<u64>,
    pub max_rate_bps: Option<u64>,
    pub initial_rate_bps: Option<u64>,
    pub params_hash: [u8; 32],
    pub version: u8,
    pub min_liquidity_out: u64,
    pub lp_name: String,
    pub lp_symbol: String,
    pub lp_uri: String,
}

/// Full Borsh payload for Omnipair `initialize` (matches `InitializeAndBootstrapArgs` on-chain).
#[derive(AnchorSerialize)]
struct OmnipairInitializeFullArgs {
    pub swap_fee_bps: u16,
    pub half_life: u64,
    pub fixed_cf_bps: Option<u16>,
    pub target_util_start_bps: Option<u64>,
    pub target_util_end_bps: Option<u64>,
    pub rate_half_life_ms: Option<u64>,
    pub min_rate_bps: Option<u64>,
    pub max_rate_bps: Option<u64>,
    pub initial_rate_bps: Option<u64>,
    pub params_hash: [u8; 32],
    pub version: u8,
    pub amount0_in: u64,
    pub amount1_in: u64,
    pub min_liquidity_out: u64,
    pub lp_name: String,
    pub lp_symbol: String,
    pub lp_uri: String,
}

/// Same algorithm as `InitializeAndBootstrap::validate` in omnipair-rs (`hash` over fixed-width LE fields).
pub fn omnipair_params_hash_matches(config: &OmnipairPoolConfigArgs) -> bool {
    if config.version != OMNIPAIR_PROTOCOL_VERSION {
        return false;
    }
    let mut hash_data = Vec::with_capacity(64);
    hash_data.extend_from_slice(&OMNIPAIR_PROTOCOL_VERSION.to_le_bytes());
    hash_data.extend_from_slice(&config.swap_fee_bps.to_le_bytes());
    hash_data.extend_from_slice(&config.half_life.to_le_bytes());
    hash_data.extend_from_slice(&config.fixed_cf_bps.unwrap_or(0).to_le_bytes());
    hash_data.extend_from_slice(&config.target_util_start_bps.unwrap_or(0).to_le_bytes());
    hash_data.extend_from_slice(&config.target_util_end_bps.unwrap_or(0).to_le_bytes());
    hash_data.extend_from_slice(&config.rate_half_life_ms.unwrap_or(0).to_le_bytes());
    hash_data.extend_from_slice(&config.min_rate_bps.unwrap_or(0).to_le_bytes());
    hash_data.extend_from_slice(&config.max_rate_bps.unwrap_or(0).to_le_bytes());
    let computed: [u8; 32] = Sha256::digest(&hash_data).into();
    computed
        .iter()
        .zip(config.params_hash.iter())
        .all(|(a, b)| a == b)
}

pub fn build_omnipair_initialize_ix_data(
    config: &OmnipairPoolConfigArgs,
    amount0_in: u64,
    amount1_in: u64,
) -> Result<Vec<u8>> {
    let full = OmnipairInitializeFullArgs {
        swap_fee_bps: config.swap_fee_bps,
        half_life: config.half_life,
        fixed_cf_bps: config.fixed_cf_bps,
        target_util_start_bps: config.target_util_start_bps,
        target_util_end_bps: config.target_util_end_bps,
        rate_half_life_ms: config.rate_half_life_ms,
        min_rate_bps: config.min_rate_bps,
        max_rate_bps: config.max_rate_bps,
        initial_rate_bps: config.initial_rate_bps,
        params_hash: config.params_hash,
        version: config.version,
        amount0_in,
        amount1_in,
        min_liquidity_out: config.min_liquidity_out,
        lp_name: config.lp_name.clone(),
        lp_symbol: config.lp_symbol.clone(),
        lp_uri: config.lp_uri.clone(),
    };
    let mut data = Vec::new();
    data.extend_from_slice(&OMNIPAIR_INITIALIZE_DISCRIMINATOR);
    full.serialize(&mut data)?;
    Ok(data)
}
