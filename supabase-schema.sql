-- ============================================================
-- higher.run — Supabase Schema
-- Run this in the Supabase SQL Editor
-- ============================================================

-- Tokens table — mirrors on-chain TokenState + off-chain metadata
create table if not exists tokens (
  mint             text primary key,
  creator          text not null,
  creator_fee_recipient text,
  name             text not null,
  symbol           text not null,
  uri              text,
  image_url        text,
  description      text,
  about            text,
  twitter          text,
  telegram         text,
  website          text,

  -- On-chain state
  phase            text not null default 'bonding' check (phase in ('bonding', 'ready_to_graduate', 'graduated')),
  virtual_sol_reserve   bigint not null default 30000000000,
  virtual_token_reserve bigint not null default 1073000191000000,
  real_sol_reserve      bigint not null default 0,
  real_token_reserve    bigint not null default 793100000000000,
  sol_raised            bigint not null default 0,
  tokens_sold           bigint not null default 0,
  total_supply          bigint not null default 1000000000000000,
  creator_fees_accumulated bigint not null default 0,

  -- Post-graduation
  gamm_pool        text,

  -- Display / computed
  current_price    double precision,
  market_cap       double precision,
  funders          integer not null default 0,

  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

-- Index for common queries
create index if not exists idx_tokens_phase on tokens (phase);
create index if not exists idx_tokens_creator on tokens (creator);
create index if not exists idx_tokens_created_at on tokens (created_at desc);

-- Trades table — mirrors TradeEvent + tx_signature
create table if not exists trades (
  id               uuid primary key default gen_random_uuid(),
  mint             text not null references tokens (mint),
  trader           text not null,
  type             text not null check (type in ('buy', 'sell')),
  sol_amount       bigint not null,
  token_amount     bigint not null,
  price            double precision,
  virtual_sol_after   bigint,
  virtual_token_after bigint,
  tx_signature     text unique,
  timestamp        timestamptz not null default now()
);

create index if not exists idx_trades_mint on trades (mint);
create index if not exists idx_trades_timestamp on trades (timestamp desc);
create index if not exists idx_trades_trader on trades (trader);
create index if not exists idx_trades_tx on trades (tx_signature);

-- Platform stats (singleton row)
create table if not exists platform_stats (
  id               integer primary key default 1 check (id = 1),
  total_tokens     integer not null default 0,
  total_sol_raised bigint not null default 0,
  total_graduated  integer not null default 0,
  updated_at       timestamptz not null default now()
);

-- Seed the singleton row
insert into platform_stats (id) values (1) on conflict do nothing;

-- Auto-update updated_at timestamp
create or replace function update_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger tokens_updated_at
  before update on tokens
  for each row execute function update_updated_at();

create trigger platform_stats_updated_at
  before update on platform_stats
  for each row execute function update_updated_at();

-- Enable Row Level Security (public read, service-role write)
alter table tokens enable row level security;
alter table trades enable row level security;
alter table platform_stats enable row level security;

-- Public read policies
create policy "tokens_public_read" on tokens for select using (true);
create policy "trades_public_read" on trades for select using (true);
create policy "platform_stats_public_read" on platform_stats for select using (true);

-- Service role write policies (indexer uses service key)
create policy "tokens_service_write" on tokens for all using (true) with check (true);
create policy "trades_service_write" on trades for all using (true) with check (true);
create policy "platform_stats_service_write" on platform_stats for all using (true) with check (true);
