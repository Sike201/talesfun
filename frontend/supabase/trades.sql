-- Canonical schema for POST /api/trades (see src/app/api/trades/route.ts).
-- New project: run this file (or use Supabase migrations).
-- Existing DB with legacy-only columns: run migrations/20260411120000_trades_align_app_payload.sql.
--
-- POST /api/trades writes canonical columns only:
--   mint, signature, side, sol_amount_raw, token_amount_raw, "timestamp", wallet, price_sol
-- (sol_amount_raw / token_amount_raw are stringified integer lamports / token base units.)
-- Upsert: onConflict "signature" → signature must be UNIQUE.
--
-- Optional legacy columns below are unused by the API; keep or drop via migration as needed.

create table if not exists public.trades (
  id uuid primary key default gen_random_uuid(),
  mint text not null,
  signature text not null unique,
  side text not null check (side in ('buy', 'sell')),
  sol_amount_raw text not null,
  token_amount_raw text not null,
  timestamp timestamptz not null,
  wallet text not null,
  price_sol double precision not null,
  created_at timestamptz default now(),
  trader text,
  "type" text,
  tx_signature text,
  sol_amount double precision,
  token_amount double precision,
  price double precision
);

create index if not exists trades_mint_timestamp_idx on public.trades (mint, timestamp desc);

alter table public.trades enable row level security;

-- Read for anon (e.g. GET /api/tokens/[mint]/trades using anon client)
create policy "Allow public read trades"
  on public.trades for select
  using (true);

-- Inserts only via service role (API route); no insert policy for anon.
