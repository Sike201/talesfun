#!/usr/bin/env bash
# Updates Vercel production/preview/development Supabase env from .env.local.
# Requires: npx vercel login (once)
set -euo pipefail
cd "$(dirname "$0")/.."

URL=$(grep '^NEXT_PUBLIC_SUPABASE_URL=' .env.local | cut -d= -f2-)
ANON=$(grep '^NEXT_PUBLIC_SUPABASE_ANON_KEY=' .env.local | cut -d= -f2-)
SECRET=$(grep '^SUPABASE_SERVICE_ROLE_KEY=' .env.local | cut -d= -f2-)

if [[ -z "$URL" || -z "$ANON" || -z "$SECRET" ]]; then
  echo "Missing Supabase keys in .env.local"
  exit 1
fi

echo "Project URL: $URL"
for ENV in production preview development; do
  echo "=== $ENV ==="
  # Remove old values if present (ignore errors)
  npx --yes vercel@39 env rm NEXT_PUBLIC_SUPABASE_URL "$ENV" -y 2>/dev/null || true
  npx --yes vercel@39 env rm NEXT_PUBLIC_SUPABASE_ANON_KEY "$ENV" -y 2>/dev/null || true
  npx --yes vercel@39 env rm SUPABASE_SERVICE_ROLE_KEY "$ENV" -y 2>/dev/null || true

  printf '%s' "$URL" | npx --yes vercel@39 env add NEXT_PUBLIC_SUPABASE_URL "$ENV"
  printf '%s' "$ANON" | npx --yes vercel@39 env add NEXT_PUBLIC_SUPABASE_ANON_KEY "$ENV"
  printf '%s' "$SECRET" | npx --yes vercel@39 env add SUPABASE_SERVICE_ROLE_KEY "$ENV"
done

echo "Redeploying production…"
npx --yes vercel@39 --prod --yes
echo "DONE"
