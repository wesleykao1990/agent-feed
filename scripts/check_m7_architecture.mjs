import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

function read(relative) {
  return readFileSync(path.join(ROOT, relative), "utf8");
}

export function checkM7Texts(input) {
  const failures = [];
  const requireText = (source, marker, label) => {
    if (!source.includes(marker)) failures.push(`${label} missing ${marker}`);
  };

  if (input.corePackage.dependencies?.["cron-parser"] !== "5.10.0") {
    failures.push("occurrence-core must exact-pin cron-parser 5.10.0");
  }
  if (input.persistencePackage.dependencies?.["@agent-feed/occurrence-core"] !== "file:../occurrence-core") {
    failures.push("persistence must consume the local occurrence-core contract");
  }
  for (const marker of [
    "MAX_MATERIALIZED_OCCURRENCES",
    "MAX_CATCH_UP_OCCURRENCES",
    "manual",
    "retry",
    "replay",
    "backfill",
    "unknown",
  ]) requireText(input.coreTypes, marker, "occurrence-core types");
  for (const marker of ["CronExpressionParser", "deterministicOccurrenceKey", "anchorMs", "limit"]) {
    requireText(input.coreSchedule, marker, "occurrence materializer");
  }
  for (const marker of ["ambiguous_window", "unsupported_trigger", "already_linked", "successful_completed", "absence"]) {
    requireText(input.coreMatching, marker, "occurrence matcher");
  }
  for (const marker of ["mark_missed", "fire_latest", "catch_up", "fail_closed", "suppressed"]) {
    requireText(input.corePolicies, marker, "occurrence policies");
  }

  for (const marker of [
    "schedule_expectation_versions",
    "expected_occurrences",
    "run_occurrence_links",
    "run_trigger_contexts",
    "schedule_expectation_migration_quarantine",
    "protect_occurrence_ledger_row",
    "validate_run_occurrence_link",
    "unique (tenant_id, occurrence_id)",
    "unique (tenant_id, run_id)",
    "expected occurrence key does not match",
    "run started_at is outside the occurrence window",
  ]) requireText(input.migration, marker, "occurrence migration");
  for (const marker of ["manual", "test", "retry", "replay", "backfill", "event", "unknown"]) {
    requireText(input.migration, marker, "database trigger-kind guard");
  }
  if (/alter\s+table\s+agent_feed\.runs\s+add\s+column/iu.test(input.migration)) {
    failures.push("M7 migration must not add occurrence fields to protocol run rows");
  }
  for (const marker of ["materializeOccurrences", "recordTrustedRunTriggerContext", "wire_run_id", "for update", "ambiguous_occurrence", "invalid_trigger_kind", "trigger_context_missing", "stream_mismatch", "invoked_failed", "absent"]) {
    requireText(input.store, marker, "PostgreSQL occurrence repository");
  }
  for (const forbidden of ["occurrence", "schedule_key", "trigger_kind", "matching_mode"]) {
    if (input.protocolSchemas.toLowerCase().includes(forbidden)) failures.push(`protocol 0.1 schemas unexpectedly contain ${forbidden}`);
  }
  for (const marker of [
    "packages/occurrence-core ci",
    "packages/persistence-postgres ci",
    "npm run m7:conformance",
  ]) requireText(input.workflow, marker, "CI workflow");
  for (const marker of [
    'packages/occurrence-core", "run", "build',
    'packages/occurrence-core", "test',
    'packages/persistence-postgres", "run", "build',
    'packages/persistence-postgres", "test',
    "AGENT_FEED_DATABASE_URL",
    "protocol compatibility",
  ]) requireText(input.runner, marker, "M7 runner");
  for (const marker of ["not a scheduler", "Protocol `0.1` remains immutable", "completion time", "quarantine"]) {
    requireText(input.milestone, marker, "M7 completion record");
  }
  return failures;
}

export function checkM7Architecture() {
  const schemaFiles = [
    "begin-run.schema.json",
    "complete-run.schema.json",
    "delivery-event.schema.json",
    "evidence.schema.json",
    "finding.schema.json",
    "run-envelope.schema.json",
    "run-bundle.schema.json",
    "stream-expectation.schema.json",
    "submit-batch.schema.json",
  ];
  const failures = checkM7Texts({
    corePackage: JSON.parse(read("packages/occurrence-core/package.json")),
    persistencePackage: JSON.parse(read("packages/persistence-postgres/package.json")),
    coreTypes: read("packages/occurrence-core/src/types.ts"),
    coreSchedule: read("packages/occurrence-core/src/schedule.ts"),
    coreMatching: read("packages/occurrence-core/src/matching.ts"),
    corePolicies: read("packages/occurrence-core/src/policies.ts"),
    migration: read("packages/persistence-postgres/migrations/0004_occurrence_ledger.sql"),
    store: read("packages/persistence-postgres/src/occurrence-store.ts"),
    protocolSchemas: schemaFiles.map((name) => read(`packages/schema/contracts/${name}`)).join("\n"),
    workflow: read(".github/workflows/ci.yml"),
    runner: read("scripts/run_m7_conformance.mjs"),
    milestone: read("docs/19_milestone_7_occurrence_ledger.md"),
  });
  if (failures.length > 0) throw new Error(`M7 occurrence architecture failed:\n- ${failures.join("\n- ")}`);
  return 9;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const count = checkM7Architecture();
    console.log(`M7 occurrence architecture checks passed (${count} boundaries checked).`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "M7 occurrence architecture failed");
    process.exitCode = 1;
  }
}
