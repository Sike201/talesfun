-- Allow activity feed sides beyond buy/sell (leverage + borrow).
alter table public.trades drop constraint if exists trades_side_check;
alter table public.trades
  add constraint trades_side_check
  check (side in ('buy', 'sell', 'long', 'short', 'borrow'));
