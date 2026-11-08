-- Tales / higher.run — full schema for a fresh Supabase project.
-- Run once in Supabase Dashboard → SQL Editor.

create table if not exists public.tokens (
  mint text primary key,
  creator text not null,
  creator_fee_recipient text,
  name text not null,
  symbol text not null,
  uri text,
  image_url text,
  description text,
  about text,
  twitter text,
  telegram text,
  website text,
  phase text not null default 'bonding'
    check (phase in ('bonding', 'ready_to_graduate', 'graduated')),
  virtual_sol_reserve bigint not null default 30000000000,
  virtual_token_reserve bigint not null default 1073000191000000,
  real_sol_reserve bigint not null default 0,
  real_token_reserve bigint not null default 793100000000000,
  sol_raised bigint not null default 0,
  tokens_sold bigint not null default 0,
  total_supply bigint not null default 1000000000000000,
  creator_fees_accumulated bigint not null default 0,
  gamm_pool text,
  current_price double precision,
  market_cap double precision,
  funders integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_tokens_phase on public.tokens (phase);
create index if not exists idx_tokens_creator on public.tokens (creator);
create index if not exists idx_tokens_created_at on public.tokens (created_at desc);

create table if not exists public.trades (
  id uuid primary key default gen_random_uuid(),
  mint text not null,
  signature text not null unique,
  side text not null check (side in ('buy', 'sell')),
  sol_amount_raw text not null,
  token_amount_raw text not null,
  "timestamp" timestamptz not null,
  wallet text not null,
  price_sol double precision not null,
  source text not null default 'bonding',
  created_at timestamptz default now(),
  trader text,
  "type" text,
  tx_signature text,
  sol_amount double precision,
  token_amount double precision,
  price double precision
);

create index if not exists trades_mint_timestamp_idx
  on public.trades (mint, "timestamp" desc);
create index if not exists trades_mint_timestamp_source_idx
  on public.trades (mint, "timestamp" desc, source);

create table if not exists public.platform_stats (
  id integer primary key default 1 check (id = 1),
  total_tokens integer not null default 0,
  total_sol_raised bigint not null default 0,
  total_graduated integer not null default 0,
  updated_at timestamptz not null default now()
);

insert into public.platform_stats (id) values (1) on conflict do nothing;

create or replace function public.update_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists tokens_updated_at on public.tokens;
create trigger tokens_updated_at
  before update on public.tokens
  for each row execute function public.update_updated_at();

drop trigger if exists platform_stats_updated_at on public.platform_stats;
create trigger platform_stats_updated_at
  before update on public.platform_stats
  for each row execute function public.update_updated_at();

alter table public.tokens enable row level security;
alter table public.trades enable row level security;
alter table public.platform_stats enable row level security;

drop policy if exists "tokens_public_read" on public.tokens;
create policy "tokens_public_read" on public.tokens for select using (true);

drop policy if exists "trades_public_read" on public.trades;
create policy "trades_public_read" on public.trades for select using (true);

drop policy if exists "Allow public read trades" on public.trades;
create policy "Allow public read trades" on public.trades for select using (true);

drop policy if exists "platform_stats_public_read" on public.platform_stats;
create policy "platform_stats_public_read" on public.platform_stats for select using (true);
