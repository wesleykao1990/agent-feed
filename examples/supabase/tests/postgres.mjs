import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createOperationsPool } from "../../../packages/operations-postgres/src/index.ts";

const ROOT = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const databaseUrl = process.env.AGENT_FEED_OPERATIONS_DATABASE_URL ?? process.env.AGENT_FEED_DATABASE_URL;

if (!databaseUrl) {
  throw new Error("AGENT_FEED_OPERATIONS_DATABASE_URL or AGENT_FEED_DATABASE_URL is required");
}

function withoutPsqlMetaCommands(sql) {
  return sql
    .split(/\r?\n/u)
    .filter((line) => !line.trimStart().startsWith("\\"))
    .join("\n");
}

const pool = createOperationsPool(databaseUrl);
try {
  // Supabase pre-creates these roles. The disposable PostgreSQL compatibility
  // gate creates NOLOGIN equivalents so the checked-in grants can be tested.
  await pool.query(`
    do $$
    begin
      if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
      if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
      if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin; end if;
    end
    $$;
  `);

  const securityMigration = await readFile(
    path.join(ROOT, "examples", "supabase", "migrations", "0004_supabase_security.sql"),
    "utf8",
  );
  await pool.query(withoutPsqlMetaCommands(securityMigration));

  const fixture = await readFile(
    path.join(ROOT, "examples", "supabase", "tests", "001_liveness_and_immutability.sql"),
    "utf8",
  );
  await pool.query(withoutPsqlMetaCommands(fixture));

  const privileges = await pool.query(`
    select
      has_schema_privilege('anon', 'agent_feed', 'USAGE') as anon_schema,
      has_schema_privilege('authenticated', 'agent_feed', 'USAGE') as authenticated_schema,
      has_table_privilege('service_role', 'agent_feed.runs', 'SELECT') as service_role_runs,
      has_function_privilege('service_role', 'agent_feed.health()', 'EXECUTE') as service_role_health
  `);
  assert.deepEqual(privileges.rows[0], {
    anon_schema: false,
    authenticated_schema: false,
    service_role_runs: false,
    service_role_health: true,
  });

  await pool.query("set role service_role");
  try {
    const health = await pool.query("select agent_feed.health() as value");
    assert.equal(health.rows[0]?.value?.ok, true);
    assert.equal(health.rows[0]?.value?.realtime_required, false);
    assert.ok(Number(health.rows[0]?.value?.migration_count) >= 4);
  } finally {
    await pool.query("reset role");
  }

  const rls = await pool.query(`
    select count(*)::int as disabled
      from pg_catalog.pg_tables
     where schemaname = 'agent_feed'
       and not rowsecurity
  `);
  assert.equal(rls.rows[0]?.disabled, 0);

  console.log("Supabase PostgreSQL-compatible migration proof passed (roles, RLS, health RPC, liveness, immutability).");
} finally {
  await pool.end();
}
