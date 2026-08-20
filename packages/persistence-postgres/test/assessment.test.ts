import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { hashValidationPolicy, normalizeValidationPolicy } from "@agent-feed/assessment-core";
import {
  ASSESSMENT_MIGRATION_SQL_URL,
  PersistenceError,
  PostgresAgentFeedPersistence,
  createAgentFeedPool,
  migrateAgentFeed,
} from "../src/index.ts";
import type { BeginRunRequest, CompleteRunRequest, SubmitAssessmentInput } from "../src/index.ts";

const databaseUrl = process.env.AGENT_FEED_DATABASE_URL;
const HASH = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

test("job-proof migration is additive, exact-vocabulary, immutable, and tenant-scoped", async () => {
  const sql = await readFile(ASSESSMENT_MIGRATION_SQL_URL, "utf8");
  for (const marker of [
    "validation_policy_versions",
    "trusted_assessor_registration_versions",
    "run_assessments",
    "assessment_declared_budgets",
    "assessment_usage_observations",
    "assessment_artifact_references",
    "policy_canonical_json",
    "protect_job_proof_row",
    "validate_job_proof_policy",
    "validate_trusted_assessor_registration",
    "validate_run_assessment",
    "runs_tenant_id_id_key",
    "0005_job_proof",
  ]) assert.match(sql, new RegExp(marker.replaceAll(".", "\\."), "i"), marker);
  for (const value of [
    "producer_self_check", "independent_agent", "human_reviewer", "validation_service",
    "technical", "quality", "security", "compliance", "operational",
    "passed", "failed", "inconclusive", "unknown",
    "observed", "not_applicable", "provider_reported", "executor_measured", "assessor_observed",
  ]) assert.match(sql, new RegExp(`['"]${value}['"]`, "i"), value);
  assert.match(sql, /foreign key \(tenant_id, run_id\)\s+references agent_feed\.runs \(tenant_id, id\)/i);
  assert.match(sql, /before update or delete on agent_feed\.run_assessments/i);
  assert.match(sql, /before update or delete on agent_feed\.assessment_usage_observations/i);
  assert.doesNotMatch(sql, /\bblob\s+(?:bytea|text)|\bbase64\s+(?:bytea|text)/iu);
});

test("assessment-core policy hashing is the persistence policy contract", () => {
  const policy = normalizeValidationPolicy({
    policyKey: "quality",
    policyVersion: "1",
    requiredAssessmentKinds: ["quality"],
    minimumIndependence: "independent",
    declaredBudgetRequirement: "optional",
  });
  assert.equal(policy.schemaVersion, "agent-feed.validation-policy.v1");
  assert.equal(hashValidationPolicy(policy).length, 64);
  assert.equal(policy.minimumIndependence, "independent");
  assert.equal(policy.declaredBudgetRequirement, "optional");
});

function begin(tenantId: string, streamId: string): BeginRunRequest {
  return {
    protocol_version: "0.1",
    tenant_id: tenantId,
    idempotency_key: `m8-begin-${randomUUID()}`,
    stream_id: streamId,
    producer: { producer_id: "m8-test", type: "automation", name: "m8-test", version: "1" },
    task: { task_type: "m8-test", definition_id: null, definition_version: null },
    expected_scope: { source_ids: [], subjects: [], queries: [], metadata: {} },
    started_at: "2026-08-20T00:00:00.000Z",
    parent_run_id: null,
    metadata: {},
    run_id: `m8-wire-${randomUUID()}`,
  };
}

function complete(runId: string, tenantId: string): CompleteRunRequest {
  return {
    protocol_version: "0.1",
    tenant_id: tenantId,
    run_id: runId,
    idempotency_key: `m8-complete-${randomUUID()}`,
    status: "completed",
    completed_at: "2026-08-20T00:01:00.000Z",
    actual_scope: { source_ids: [], subjects: [], queries: [], metadata: {} },
    stats: { sources_attempted: 0, sources_succeeded: 0, findings_submitted: 0, evidence_submitted: 0, batches_submitted: 0 },
    errors: [],
    metadata: {},
  };
}

function assessment(runId: string, policyId: string, key: string): SubmitAssessmentInput {
  return {
    tenant_id: "m8-tenant",
    run_id: runId,
    policy_version_id: policyId,
    request_idempotency_key: key,
    assessment_kind: "quality",
    verdict: "passed",
    failure_stage: "none",
    failure_class: "none",
    stop_reason: "completed",
    summary: "quality receipt",
    usage_observations: [{ metric: "wall_time_ms", state: "unknown", value: null, provenance: "unknown", observed_at: "2026-08-20T00:00:00+00:00" }],
    artifact_references: [{ artifact_key: "report", artifact_kind: "json_report", artifact_hash: HASH, reference: "object://m8/report", provenance: "executor", media_type: "application/json" }],
  };
}

test("live PostgreSQL job-proof repository preserves authority, idempotency, reassessment, and immutable children", { skip: databaseUrl ? false : "AGENT_FEED_DATABASE_URL is not set; live PostgreSQL gate not executed" }, async () => {
  const pool = createAgentFeedPool(databaseUrl);
  try {
    await migrateAgentFeed(pool);
    await migrateAgentFeed(pool);
    const versions = await pool.query<{ version: string }>("select version from agent_feed.schema_migrations where version = '0005_job_proof'");
    assert.equal(versions.rows.length, 1);
    const store = new PostgresAgentFeedPersistence(pool);
    const run = await store.beginRun(begin("m8-tenant", `m8-stream-${randomUUID()}`));
    const policy = await store.createValidationPolicyVersion({
      tenant_id: "m8-tenant",
      policy_key: `m8-quality-${randomUUID()}`,
      version: 1,
      policy: { requiredAssessmentKinds: ["quality"], minimumIndependence: "independent", declaredBudgetRequirement: "optional" },
    });
    const independent = await store.registerTrustedAssessorVersion({
      tenant_id: "m8-tenant",
      assessor_id: "m8-quality-service",
      assessor_type: "validation_service",
      independence: "independent",
      subject_digest: HASH,
    });
    const self = await store.registerTrustedAssessorVersion({
      tenant_id: "m8-tenant",
      assessor_id: "m8-producer",
      assessor_type: "producer_self_check",
      independence: "independent",
      subject_digest: HASH,
    });
    assert.equal(self.independence, "self", "producer self-check registration must be forced to self");

    const firstInput = assessment(run.run_id, policy.id, `m8-assess-${randomUUID()}`);
    const first = await store.submitAssessment(firstInput, { tenant_id: "m8-tenant", assessor_registration_version_id: independent.id });
    assert.equal(first.run_id, run.run_id);
    assert.equal(first.run_status, "running");
    assert.equal(first.assessor_independence, "independent");
    assert.equal(first.artifact_references[0]?.artifact_hash, HASH);
    assert.equal(first.usage_observations[0]?.usage_key, "wall_time_ms");
    assert.equal(first.usage_observations[0]?.observed_at, "2026-08-20T00:00:00.000Z");
    assert.equal(first.artifact_references[0]?.media_type, "application/json");
    assert.equal((await store.submitAssessment({ ...firstInput }, { tenant_id: "m8-tenant", assessor_registration_version_id: independent.id })).id, first.id);
    await assert.rejects(store.submitAssessment({ ...firstInput, summary: "drift" }, { tenant_id: "m8-tenant", assessor_registration_version_id: independent.id }), (error: unknown) => error instanceof PersistenceError && error.code === "assessment_conflict");
    await assert.rejects(store.submitAssessment({ ...firstInput }, { tenant_id: "m8-tenant", assessor_registration_version_id: self.id }), /independent|assessment|policy/i);
    await assert.rejects(store.submitAssessment({ ...firstInput, request_idempotency_key: `m8-assess-${randomUUID()}`, usage_observations: [{ usage_key: "wall", metric: "wall_time_ms", state: "observed", value: 2, provenance: "unknown" }] }, { tenant_id: "m8-tenant", assessor_registration_version_id: independent.id }), /non-unknown|assessment-core|provenance/i);

    const reassessed = await store.submitAssessment({ ...firstInput, request_idempotency_key: `m8-reassessment-${randomUUID()}`, reassessment_of: first.id, verdict: "inconclusive" }, { tenant_id: "m8-tenant", assessor_registration_version_id: independent.id });
    assert.notEqual(reassessed.id, first.id);
    assert.equal(reassessed.reassessment_of, first.id);
    assert.equal((await store.listAssessments({ tenant_id: "m8-tenant", run_id: run.run_id })).length, 2);
    await store.completeRun(complete(run.run_id, "m8-tenant"));
    const afterComplete = await store.getAssessment("m8-tenant", first.id);
    assert.equal(afterComplete?.run_status, "completed");
    assert.equal(afterComplete?.verdict, "passed", "quality proof is not technical run status");
    await assert.rejects(pool.query("update agent_feed.run_assessments set summary = 'tampered' where tenant_id = $1 and id = $2", ["m8-tenant", first.id]), /append-only/i);
    await assert.rejects(pool.query("delete from agent_feed.assessment_artifact_references where tenant_id = $1 and assessment_id = $2", ["m8-tenant", first.id]), /append-only/i);
    assert.equal(await store.getAssessment("other-tenant", first.id), null);
  } finally {
    await pool.end();
  }
});
