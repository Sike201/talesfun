-- Omnipair indexer + client dedupe: bonding vs GAMM source of trade rows.
ALTER TABLE public.trades
  ADD COLUMN IF NOT EXISTS source text;

UPDATE public.trades
SET source = 'bonding'
WHERE source IS NULL;

ALTER TABLE public.trades
  ALTER COLUMN source SET DEFAULT 'bonding';

ALTER TABLE public.trades
  ALTER COLUMN source SET NOT NULL;

CREATE INDEX IF NOT EXISTS trades_mint_timestamp_source_idx
  ON public.trades (mint, "timestamp" DESC, source);
