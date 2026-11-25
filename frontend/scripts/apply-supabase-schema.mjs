/**
 * Apply frontend/supabase/bootstrap.sql to the linked Supabase project.
 *
 * Needs the database password (Project Settings → Database → Database password):
 *   SUPABASE_DB_PASSWORD='…' node --env-file=.env.local scripts/apply-supabase-schema.mjs
 *
 * Or a full URL:
 *   DATABASE_URL='postgresql://postgres.…' node --env-file=.env.local scripts/apply-supabase-schema.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const SQL_PATH = path.join(ROOT, "supabase", "bootstrap.sql");

function projectRefFromUrl(url) {
  try {
    const host = new URL(url).hostname;
    return host.split(".")[0] || null;
  } catch {
    return null;
  }
}

function buildConnectionString() {
  if (process.env.DATABASE_URL?.trim()) return process.env.DATABASE_URL.trim();
  const password = process.env.SUPABASE_DB_PASSWORD?.trim();
  if (!password) return null;
  const ref =
    process.env.SUPABASE_PROJECT_REF?.trim() ||
    projectRefFromUrl(process.env.NEXT_PUBLIC_SUPABASE_URL || "");
  if (!ref) {
    throw new Error("Set SUPABASE_PROJECT_REF or NEXT_PUBLIC_SUPABASE_URL");
  }
  const regions = (
    process.env.SUPABASE_POOLER_REGION?.trim() ||
    "eu-central-1,eu-west-1,us-east-1,us-west-1,ap-southeast-1"
  ).split(",");
  return regions.map(
    (region) =>
      `postgresql://postgres.${ref}:${encodeURIComponent(password)}@aws-0-${region.trim()}.pooler.supabase.com:5432/postgres`
  );
}

async function connectFirst(connectionStrings) {
  let lastErr;
  for (const cs of connectionStrings) {
    const client = new pg.Client({
      connectionString: cs,
      ssl: { rejectUnauthorized: false },
      connectionTimeoutMillis: 8000,
    });
    try {
      await client.connect();
      console.log("connected via", cs.split("@")[1]);
      return client;
    } catch (e) {
      lastErr = e;
      try {
        await client.end();
      } catch {
        /* ignore */
      }
    }
  }
  throw lastErr || new Error("Could not connect to any pooler region");
}

async function main() {
  const built = buildConnectionString();
  if (!built) {
    console.error(
      "Missing SUPABASE_DB_PASSWORD or DATABASE_URL.\n" +
        "Get the DB password from Supabase → Project Settings → Database."
    );
    process.exit(1);
  }
  const connectionStrings = Array.isArray(built) ? built : [built];
  const sql = fs.readFileSync(SQL_PATH, "utf8");
  const client = await connectFirst(connectionStrings);
  console.log("applying", SQL_PATH);
  await client.query(sql);
  const tables = await client.query(
    `select tablename from pg_tables where schemaname='public' order by 1`
  );
  console.log(
    "tables:",
    tables.rows.map((r) => r.tablename).join(", ")
  );
  await client.end();
  console.log("SCHEMA OK");
}

main().catch((e) => {
  console.error("SCHEMA FAIL", e.message || e);
  process.exit(1);
});
