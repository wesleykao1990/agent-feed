import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migrationPath = new URL("../migrations/0002_durable_delivery.sql", import.meta.url);
const migration = await readFile(migrationPath, "utf8");

function has(pattern: RegExp): void {
  assert.match(migration, pattern);
}

test("M2 migration is additive, idempotence-ready, and preserves protocol 0.1", () => {
  assert.match(migration, /^\\set ON_ERROR_STOP on/m);
  assert.doesNotMatch(migration, /\b(drop\s+table|truncate\s+table|delete\s+from)\b/i);
  assert.doesNotMatch(migration, /['"]0\.2['"]/);
  assert.match(migration, /create\s+table\s+if\s+not\s+exists\s+agent_feed\.schema_migrations/i);
  assert.match(migration, /insert\s+into\s+agent_feed\.schema_migrations[\s\S]*0002_durable_delivery/i);
  assert.ok((migration.match(/create\s+table\s+if\s+not\s+exists/gi) ?? []).length >= 6);
  assert.ok((migration.match(/create\s+index\s+if\s+not\s+exists/gi) ?? []).length >= 6);
  assert.ok((migration.match(/drop\s+trigger\s+if\s+exists/gi) ?? []).length >= 8);
  assert.ok((migration.match(/create\s+or\s+replace\s+function/gi) ?? []).length >= 10);
});

test("M2 migration upgrades the reserved outbox without global delivery state", () => {
  for (const marker of [
    "alter table agent_feed.outbox_events",
    "event_id",
    "event_key",
    "protocol_version",
    "occurred_at",
    "payload_hash",
    "stream_position",
    "delivery_eligibility",
    "quarantine_reason",
    "outbox_events_tenant_event_id_key",
    "outbox_events_stream_position_key",
    "outbox_events_append_only",
    "outbox_events_scope_guard",
    "next_stream_event_position",
    "stream_event_counters",
  ]) has(new RegExp(marker.replaceAll(".", "\\."), "i"));

  has(/delivered_at[\s\S]*never used as delivery state/i);
  assert.doesNotMatch(migration, /\bset\s+delivered_at\b/i);
  assert.doesNotMatch(migration, /\bwhere\s+delivered_at\b/i);
  has(/check\s*\(protocol_version\s*=\s*['"]0\.1['"]\)/i);
  has(/event_type\s+in\s*\([\s\S]*finding\.submitted[\s\S]*run\.failed/i);
});

test("M2 migration defines tenant-scoped selectors and fan-out delivery state", () => {
  for (const table of [
    "consumer_subscriptions",
    "consumer_deliveries",
    "delivery_attempts",
    "acknowledgements",
    "delivery_replays",
  ]) has(new RegExp(`create\\s+table\\s+if\\s+not\\s+exists\\s+agent_feed\\.${table}`, "i"));

  for (const marker of [
    "tenant_id",
    "consumer_id",
    "selector_version",
    "delivery_mode",
    "signing_secret_ref",
    "finding_type",
    "routing_tag",
    "endpoint_url",
    "starts_at",
    "cursor_created_at",
    "consumer_subscriptions_selector_uidx",
    "consumer_deliveries_subscription_fk",
    "consumer_deliveries_event_fk",
  ]) has(new RegExp(marker.replaceAll(".", "\\."), "i"));

  has(/state\s+in\s*\(['"]pending['"],\s*['"]in_flight['"],\s*['"]retry_wait['"],\s*['"]acknowledged['"],\s*['"]dead_letter['"]\)/i);
  has(/unique\s*\(tenant_id,\s*subscription_id,\s*event_id\)/i);
  has(/consumer_deliveries_claim_idx/i);
  assert.doesNotMatch(migration, /for\s+update\s+skip\s+locked/i);
});

test("M2 migration records attempts, acknowledgements, replay idempotency, and append-only guards", () => {
  for (const marker of [
    "attempt_number",
    "attempt_kind",
    "request_body_hash",
    "signing_secret_ref",
    "http_status",
    "acknowledgement_key",
    "acknowledgement_payload_hash",
    "delivery_replays",
    "replay_idempotency_key",
    "replay_generation",
    "delivery_attempts_append_only",
    "acknowledgements_append_only",
    "delivery_replays_append_only",
    "protect_consumer_delivery_transition",
  ]) has(new RegExp(marker.replaceAll(".", "\\."), "i"));

  has(/unique\s*\(tenant_id,\s*consumer_id,\s*delivery_id,\s*attempt_number\)/i);
  has(/unique\s*\(tenant_id,\s*consumer_id,\s*delivery_id,\s*replay_idempotency_key\)/i);
  has(/dead[-_]letter\s+delivery\s+can\s+only\s+be\s+replayed\s+to\s+pending/i);
  has(/acknowledged\s+delivery\s+is\s+terminal/i);
});

test("M2 migration adds same-run and same-tenant guards without rewriting M1 history", () => {
  for (const marker of [
    "batches_tenant_run_fk",
    "findings_tenant_run_fk",
    "submitted_evidence_tenant_run_fk",
    "finding_evidence_tenant_finding_fk",
    "finding_evidence_tenant_evidence_fk",
    "protect_finding_evidence_scope",
    "assert_outbox_event_scope",
    "outbox_events_tenant_run_fk",
    "outbox_events_tenant_finding_fk",
  ]) has(new RegExp(marker.replaceAll(".", "\\."), "i"));

  has(/foreign\s+key[\s\S]*not\s+valid/i);
  has(/finding\/evidence reference crosses run or tenant scope/i);
  has(/outbox event crosses run or tenant scope/i);
  has(/outbox finding crosses run or tenant scope/i);
  has(/agent_feed\.runs[\s\S]*add\s+column\s+if\s+not\s+exists\s+tenant_id/i);
  has(/values\s*\(['"]0002_durable_delivery['"]\)[\s\S]*on\s+conflict\s*\(version\)\s+do\s+nothing/i);
});
