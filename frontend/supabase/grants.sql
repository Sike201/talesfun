-- Run once after bootstrap.sql (fixes "permission denied for table …").
-- Supabase SQL Editor → New query → Run.

grant usage on schema public to anon, authenticated, service_role;

grant select on table public.tokens to anon, authenticated;
grant select on table public.trades to anon, authenticated;
grant select on table public.platform_stats to anon, authenticated;

grant all on table public.tokens to service_role;
grant all on table public.trades to service_role;
grant all on table public.platform_stats to service_role;

grant usage, select on all sequences in schema public to anon, authenticated, service_role;
