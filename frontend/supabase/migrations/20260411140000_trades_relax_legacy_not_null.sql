-- Optional: after POST /api/trades dual-writes legacy + canonical columns, relax NOT NULL on
-- legacy fields so only wallet/signature/side/… are required long-term.
-- Safe to skip if you prefer to keep legacy NOT NULL and rely on the API mirrors.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'trades' AND column_name = 'trader'
  ) THEN
    EXECUTE 'ALTER TABLE public.trades ALTER COLUMN trader DROP NOT NULL';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'trades' AND column_name = 'type'
  ) THEN
    EXECUTE 'ALTER TABLE public.trades ALTER COLUMN "type" DROP NOT NULL';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'trades' AND column_name = 'tx_signature'
  ) THEN
    EXECUTE 'ALTER TABLE public.trades ALTER COLUMN tx_signature DROP NOT NULL';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'trades' AND column_name = 'sol_amount'
  ) THEN
    EXECUTE 'ALTER TABLE public.trades ALTER COLUMN sol_amount DROP NOT NULL';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'trades' AND column_name = 'token_amount'
  ) THEN
    EXECUTE 'ALTER TABLE public.trades ALTER COLUMN token_amount DROP NOT NULL';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'trades' AND column_name = 'price'
  ) THEN
    EXECUTE 'ALTER TABLE public.trades ALTER COLUMN price DROP NOT NULL';
  END IF;
END;
$$;
