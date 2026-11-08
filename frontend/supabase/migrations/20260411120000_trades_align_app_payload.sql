-- Align public.trades with POST /api/trades (src/app/api/trades/route.ts).
-- App normalized row: mint, signature, side, sol_amount_raw, token_amount_raw,
--   "timestamp", wallet, price_sol  (+ optional id uuid, created_at)
-- Upsert: onConflict "signature" → column signature must be UNIQUE.

-- ── 1) Add columns the app expects (nullable first; safe on non-empty tables)
ALTER TABLE public.trades
  ADD COLUMN IF NOT EXISTS id uuid DEFAULT gen_random_uuid(),
  ADD COLUMN IF NOT EXISTS mint text,
  ADD COLUMN IF NOT EXISTS signature text,
  ADD COLUMN IF NOT EXISTS side text,
  ADD COLUMN IF NOT EXISTS sol_amount_raw text,
  ADD COLUMN IF NOT EXISTS token_amount_raw text,
  ADD COLUMN IF NOT EXISTS "timestamp" timestamptz,
  ADD COLUMN IF NOT EXISTS wallet text,
  ADD COLUMN IF NOT EXISTS price_sol double precision;

-- Backfill id only for rows that ended up NULL (e.g. column added without default on old PG)
UPDATE public.trades SET id = gen_random_uuid() WHERE id IS NULL;

-- ── 2) Backfill from legacy columns only when those columns exist
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'trades' AND column_name = 'tx_signature'
  ) THEN
    EXECUTE $u$
      UPDATE public.trades SET signature = COALESCE(signature, tx_signature)
      WHERE tx_signature IS NOT NULL
    $u$;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'trades' AND column_name = 'trader'
  ) THEN
    EXECUTE $u$
      UPDATE public.trades SET wallet = COALESCE(wallet, trader)
      WHERE trader IS NOT NULL
    $u$;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'trades' AND column_name = 'type'
  ) THEN
    EXECUTE $u$
      UPDATE public.trades SET side = COALESCE(
        side,
        CASE
          WHEN lower(btrim(COALESCE("type", ''))) IN ('buy', 'sell') THEN lower(btrim("type"))
          ELSE NULL
        END
      )
      WHERE "type" IS NOT NULL
    $u$;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'trades' AND column_name = 'sol_amount'
  ) THEN
    EXECUTE $u$
      UPDATE public.trades SET sol_amount_raw = COALESCE(sol_amount_raw, sol_amount::text)
      WHERE sol_amount IS NOT NULL
    $u$;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'trades' AND column_name = 'token_amount'
  ) THEN
    EXECUTE $u$
      UPDATE public.trades SET token_amount_raw = COALESCE(token_amount_raw, token_amount::text)
      WHERE token_amount IS NOT NULL
    $u$;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'trades' AND column_name = 'price'
  ) THEN
    EXECUTE $u$
      UPDATE public.trades SET price_sol = COALESCE(price_sol, price::double precision)
      WHERE price IS NOT NULL
    $u$;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'trades' AND column_name = 'created_at'
  ) THEN
    EXECUTE $u$
      UPDATE public.trades SET "timestamp" = COALESCE("timestamp", created_at)
      WHERE created_at IS NOT NULL AND "timestamp" IS NULL
    $u$;
  END IF;
END;
$$;

-- Default timestamp for any row still missing it (optional safety)
UPDATE public.trades SET "timestamp" = now() WHERE "timestamp" IS NULL;

-- ── 3) Drop common legacy UNIQUE on tx_signature (name varies; add more IF NEEDED)
ALTER TABLE public.trades DROP CONSTRAINT IF EXISTS trades_tx_signature_key;
ALTER TABLE public.trades DROP CONSTRAINT IF EXISTS trades_tx_signature_unique;

-- ── 4) UNIQUE(signature) for Supabase upsert onConflict: "signature"
--    (Skip if any UNIQUE on signature already exists — Postgres names vary.)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint c
    JOIN pg_class rel ON rel.oid = c.conrelid
    JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
    WHERE nsp.nspname = 'public'
      AND rel.relname = 'trades'
      AND c.contype = 'u'
      AND pg_get_constraintdef(c.oid) LIKE '%signature%'
  ) THEN
    ALTER TABLE public.trades
      ADD CONSTRAINT trades_signature_key UNIQUE (signature);
  END IF;
EXCEPTION
  WHEN unique_violation THEN
    RAISE NOTICE 'trades_signature_key failed: duplicate signature values — dedupe then re-run';
END;
$$;

-- ── 5) Side check (allows NULL for incomplete legacy rows)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.trades'::regclass AND conname = 'trades_side_check'
  ) THEN
    ALTER TABLE public.trades
      ADD CONSTRAINT trades_side_check CHECK (side IS NULL OR side IN ('buy', 'sell'));
  END IF;
END;
$$;

-- ── 6) Index for GET /api/tokens/[mint]/trades
CREATE INDEX IF NOT EXISTS trades_mint_timestamp_idx ON public.trades (mint, "timestamp" DESC);

-- Legacy columns (trader, type, sol_amount, token_amount, price, tx_signature) are intentionally
-- left in place for backward compatibility until you drop them manually after verifying reads/writes.
