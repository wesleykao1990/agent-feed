import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const EXAMPLE = path.join(ROOT, "examples", "supabase");

async function text(relative) {
  return readFile(path.join(EXAMPLE, relative), "utf8");
}

function includes(value, marker, label) {
  assert.ok(value.includes(marker), `${label} is missing ${marker}`);
}

const canonicalMigrations = ["0001_agent_feed.sql", "0002_durable_delivery.sql", "0003_wire_run_id.sql"];
for (const name of canonicalMigrations) {
  const [reference, supabase] = await Promise.all([
    readFile(path.join(ROOT, "packages", "persistence-postgres", "migrations", name), "utf8"),
    text(path.join("migrations", name)),
  ]);
  assert.equal(supabase, reference, `${name} drifted from canonical PostgreSQL history`);
}

const config = await text("config.toml");
includes(config, 'project_id = "agent-feed"', "Supabase config");
includes(config, "[functions.producer-ingress]", "Supabase config");
includes(config, "verify_jwt = false", "Supabase config");

const security = await text(path.join("migrations", "0004_supabase_security.sql"));
for (const marker of [
  "revoke all on schema agent_feed from public, anon, authenticated",
  "grant usage on schema agent_feed to service_role",
  "enable row level security",
  "create or replace function agent_feed.health()",
  "realtime_required', false",
  "alter default privileges in schema agent_feed",
]) includes(security, marker, "Supabase security migration");
assert.doesNotMatch(security, /grant\s+.*\b(?:anon|authenticated)\b/iu, "browser roles must not receive Agent Feed grants");
assert.doesNotMatch(security, /grant\s+(?:all|select|insert|update|delete|usage)\s+on\s+(?:all\s+)?(?:tables|sequences)\b[^;]*\bservice_role\b/iu, "service_role must not receive broad core-table grants");
assert.doesNotMatch(security, /force row level security/iu, "the trusted canonical API owner connection must remain usable");

const fixture = await text(path.join("tests", "001_liveness_and_immutability.sql"));
for (const marker of ["begin;", "sweep_overdue_streams", "terminal run", "rollback;"]) {
  includes(fixture, marker, "Supabase SQL proof fixture");
}

const edge = await text(path.join("functions", "producer-ingress", "index.ts"));
for (const marker of [
  "AGENT_FEED_INGRESS_URL",
  "MAX_BODY_BYTES = 1024 * 1024",
  "MAX_RESPONSE_BODY_BYTES = 2 * 1024 * 1024",
  "readBoundedResponseBody",
  "await reader.cancel()",
  "routeAllowed",
  'headers.set("authorization", authorization)',
  'headers.set("content-type", contentType)',
  'headers.set("x-request-id", requestId)',
  'value.protocol !== "https:"',
  'redirect: "error"',
  'error: "route_not_allowed"',
]) includes(edge, marker, "Supabase ingress function");
assert.doesNotMatch(edge, /headers\.set\(\s*["']cookie/iu, "ingress relay must not forward cookie headers");
assert.doesNotMatch(edge, /response\.arrayBuffer\(\)/iu, "ingress relay must not buffer an unbounded upstream response");

const readme = await text("README.md");
for (const marker of [
  "not proof that a hosted project",
  "byte-for-byte copies",
  "canonical producer service and delivery worker remain the policy boundaries",
  "Realtime is not needed",
  "AGENT_FEED_INGRESS_URL",
  "signed HTTPS",
]) includes(readme, marker, "Supabase README");

for (const [name, markers] of [
  ["DECISIONS.md", ["S-001", "S-003", "S-005"]],
  ["BUGS.md", ["S-BUG-001", "S-BUG-003", "S-BUG-004"]],
  ["LEARNINGS.md", ["application boundary", "generic JWT", "static deployment example"]],
]) {
  const document = await text(name);
  for (const marker of markers) includes(document, marker, `Supabase ${name}`);
}

console.log(`Supabase reference checks passed (${canonicalMigrations.length + 9} boundaries checked).`);
