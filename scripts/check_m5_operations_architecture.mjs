import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

export function checkM5OperationsTexts(input) {
  const failures = [];
  const requireText = (text, marker, label) => {
    if (!text.includes(marker)) failures.push(`${label} missing ${marker}`);
  };

  for (const marker of ["tenant_id", "finding_evidence_same_run", "stream_liveness_incidents", "terminal run envelope"]) {
    requireText(input.sqliteSchema, marker, "SQLite schema");
  }
  for (const marker of ["managed_artifact", "protected_entity", "MAX_RETENTION_CANDIDATES", "retention_plan_mismatch"]) {
    requireText(input.operationsCore, marker, "operations-core retention boundary");
  }
  for (const marker of [
    "retention_job_items_tenant_job_fk",
    "retention_job_items_tenant_artifact_fk",
    "protect_retention_job_item",
    "claim_expires_at",
    "operations_audit_append_only",
  ]) requireText(input.operationsMigration, marker, "operations PostgreSQL migration");
  if (/delete\s+from\s+agent_feed\.(?:runs|batches|findings|submitted_evidence|outbox_events|consumer_deliveries|delivery_attempts|acknowledgements|delivery_replays)/iu.test(input.operationsMigration)) {
    failures.push("operations migration deletes immutable protocol or delivery history");
  }
  if (/alter\s+table\s+agent_feed\.(?:stream_expectations|stream_liveness_incidents)/iu.test(input.operationsMigration)) {
    failures.push("operations migration claims tenant isolation by mutating the globally keyed liveness schema");
  }
  for (const marker of ["validateSnapshot(snapshot)", "OBSERVABILITY_FAMILY_DEFINITIONS", "agent_feed_liveness_streams"]) {
    requireText(input.observability, marker, "observability exporter");
  }
  for (const marker of ["isLoopbackAddress", "authorize", "containsCredentialQuery"]) {
    requireText(input.dashboardServer, marker, "dashboard server");
  }
  for (const marker of ["mapMetricSnapshotToDashboardSnapshot", "agent_feed_delivery_pending_events", "state", "overdue"]) {
    requireText(input.dashboardAdapter, marker, "dashboard observability adapter");
  }
  for (const marker of ["MAX_RESPONSE_BODY_BYTES", "AGENT_FEED_INGRESS_URL", "redirect: \"error\""]) {
    requireText(input.supabaseEdge, marker, "Supabase Edge relay");
  }
  if (/\b(?:postgres_changes|RealtimeChannel|supabase\.channel)\b/iu.test(input.supabaseEdge)) {
    failures.push("Supabase Edge relay must not introduce a Realtime queue path");
  }
  for (const marker of ["m5a:conformance", "m5:conformance"]) requireText(input.rootPackage, marker, "root package");
  for (const marker of [
    "portability and operations architecture guard",
    "SQLite portability reference",
    "Supabase PostgreSQL-compatible migration proof",
    "AGENT_FEED_OPERATIONS_DATABASE_URL",
  ]) requireText(input.runner, marker, "M5 runner");
  for (const marker of [
    "packages/operations-core",
    "packages/operations-observability",
    "packages/operations-postgres",
    "apps/admin-dashboard",
    "npm run m5:conformance",
  ]) requireText(input.workflow, marker, "CI workflow");

  return failures;
}

export function checkM5OperationsArchitecture(root = ROOT) {
  const read = (relative) => readFileSync(path.join(root, relative), "utf8");
  const failures = checkM5OperationsTexts({
    sqliteSchema: read("examples/sqlite/schema.sql"),
    operationsCore: `${read("packages/operations-core/src/types.ts")}\n${read("packages/operations-core/src/retention.ts")}`,
    operationsMigration: read("packages/operations-postgres/migrations/0004_operations.sql"),
    observability: `${read("packages/operations-observability/src/collect.ts")}\n${read("packages/operations-observability/src/prometheus.ts")}`,
    dashboardServer: read("apps/admin-dashboard/src/server.ts"),
    dashboardAdapter: read("apps/admin-dashboard/src/observability.ts"),
    supabaseEdge: read("examples/supabase/functions/producer-ingress/index.ts"),
    rootPackage: read("package.json"),
    runner: read("scripts/run_m5_conformance.mjs"),
    workflow: read(".github/workflows/ci.yml"),
  });
  if (failures.length) throw new Error(`M5 portability/operations architecture failed:\n- ${failures.join("\n- ")}`);
  return 7;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const count = checkM5OperationsArchitecture();
    console.log(`M5 portability/operations architecture checks passed (${count} boundaries checked).`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "M5 portability/operations architecture failed");
    process.exitCode = 1;
  }
}
