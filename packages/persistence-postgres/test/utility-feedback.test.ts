import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  normalizeOptimizationRecommendation,
  normalizeRecommendationApproval,
  normalizeUtilityFeedback,
} from "@agent-feed/utility-feedback-core";
import {
  PersistenceError,
  PostgresAgentFeedPersistence,
  PostgresUtilityFeedbackRepository,
  createAgentFeedPool,
  migrateAgentFeed,
  type BeginRunRequest,
  type SubmitBatchRequest,
} from "../src/index.ts";

const databaseUrl = process.env.AGENT_FEED_DATABASE_URL;
const HASH = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

function begin(tenantId: string, streamId: string, runId: string): BeginRunRequest {
  return {
    protocol_version: "0.1", tenant_id: tenantId, idempotency_key: `m12-begin-${randomUUID()}`,
    stream_id: streamId, producer: { producer_id: "m12-test", type: "automation", name: "m12", version: "1" },
    task: { task_type: "m12-utility-feedback", definition_id: null, definition_version: null },
    expected_scope: { source_ids: [], subjects: [], queries: [], metadata: {} },
    started_at: "2026-08-20T09:00:00.000Z", parent_run_id: null, metadata: {}, run_id: runId,
  };
}

function batch(tenantId: string, runId: string, findingId: string): SubmitBatchRequest {
  return {
    protocol_version: "0.1", tenant_id: tenantId, run_id: runId, batch_id: `batch-${randomUUID()}`,
    idempotency_key: `m12-batch-${randomUUID()}`, sequence_number: 1, submitted_at: "2026-08-20T09:01:00.000Z",
    findings: [{ finding_id: findingId, finding_type: "monitoring", title: "M12 target", summary: "Target identity fixture", subjects: [], evidence_refs: [], security_flags: [] }],
    evidence: [], metadata: {},
  };
}

test("live PostgreSQL utility ledger is tenant-scoped, idempotent, and append-only", {
  skip: databaseUrl === undefined ? "AGENT_FEED_DATABASE_URL is required for live M12 persistence acceptance" : false,
}, async () => {
  const pool = createAgentFeedPool(databaseUrl);
  const tenantId = `m12_${randomUUID()}`;
  const otherTenant = `m12_other_${randomUUID()}`;
  const consumerId = `consumer-${randomUUID()}`;
  const streamId = `stream-${randomUUID()}`;
  const runId = `run-m12-${randomUUID()}`;
  const findingId = `finding-${randomUUID()}`;
  const scope = { jobKey: "monitor-job", definitionVersion: 1, jobDefinitionHash: HASH, validationPolicyVersionId: "policy-v1" };
  try {
    await migrateAgentFeed(pool);
    await migrateAgentFeed(pool);
    const persistence = new PostgresAgentFeedPersistence(pool);
    await persistence.beginRun(begin(tenantId, streamId, runId));
    await persistence.submitBatch(batch(tenantId, runId, findingId));
    const repository = new PostgresUtilityFeedbackRepository(pool);
    const record = normalizeUtilityFeedback({
      feedbackKey: "feedback-pg-001", target: { targetKind: "finding", streamId, runId, findingId }, scope,
      disposition: "surfaced", reasonCode: "relevant", occurredAt: "2026-08-20T10:00:00.000Z",
    }, { tenantId, consumerId });
    assert.equal((await repository.appendFeedback(record)).appended, true);
    assert.equal((await repository.appendFeedback(record)).appended, false);
    assert.equal((await repository.getFeedback(otherTenant, consumerId, record.feedbackKey)), null);

    const conflicting = normalizeUtilityFeedback({
      feedbackKey: record.feedbackKey, target: record.target, scope, disposition: "ignored",
      reasonCode: "not_relevant", occurredAt: record.occurredAt,
    }, record.owner);
    await assert.rejects(() => repository.appendFeedback(conflicting),
      (error: unknown) => error instanceof PersistenceError && error.code === "utility_feedback_conflict");

    const crossTenant = normalizeUtilityFeedback({
      feedbackKey: "feedback-cross-tenant", target: { targetKind: "finding", streamId, runId, findingId }, scope,
      disposition: "surfaced", reasonCode: "relevant", occurredAt: "2026-08-20T10:00:00.000Z",
    }, { tenantId: otherTenant, consumerId });
    await assert.rejects(() => repository.appendFeedback(crossTenant),
      (error: unknown) => error instanceof PersistenceError && error.code === "utility_feedback_validation_failed");

    await assert.rejects(() => pool.query(
      "update agent_feed.utility_feedback_events set disposition = 'ignored' where tenant_id = $1 and consumer_id = $2 and feedback_key = $3",
      [tenantId, consumerId, record.feedbackKey],
    ));
    await assert.rejects(() => pool.query(
      `with source as (
         select *, jsonb_set(record_json - 'recordHash', '{feedbackKey}', to_jsonb(feedback_key || '-extra'))
           || '{"promptBody":"forbidden"}'::jsonb as mutated_base
           from agent_feed.utility_feedback_events
          where tenant_id = $1 and consumer_id = $2 and feedback_key = $3
       ), mutated as (
         select *, encode(digest(convert_to(mutated_base::text, 'utf8'), 'sha256'), 'hex') as mutated_hash from source
       ) insert into agent_feed.utility_feedback_events (
         id, tenant_id, consumer_id, feedback_key, target_kind, stream_id, wire_run_id,
         finding_id, assessment_receipt_id, artifact_digest, job_key, definition_version,
         job_definition_hash, validation_policy_version_id, disposition, reason_code, occurred_at,
         record_json, record_canonical_json, record_hash
       ) select gen_random_uuid(), tenant_id, consumer_id, feedback_key || '-extra', target_kind,
         stream_id, wire_run_id, finding_id, assessment_receipt_id, artifact_digest, job_key,
         definition_version, job_definition_hash, validation_policy_version_id, disposition,
         reason_code, occurred_at, mutated_base || jsonb_build_object('recordHash', mutated_hash),
         mutated_base::text, mutated_hash from mutated`,
      [tenantId, consumerId, record.feedbackKey],
    ), "direct SQL cannot add a forbidden field even with a self-consistent hash");
    await assert.rejects(() => pool.query(
      `insert into agent_feed.utility_feedback_events (
        id, tenant_id, consumer_id, feedback_key, target_kind, stream_id, wire_run_id,
        finding_id, assessment_receipt_id, artifact_digest, job_key, definition_version,
        job_definition_hash, validation_policy_version_id, disposition, reason_code, occurred_at,
        record_json, record_canonical_json, record_hash
      ) select gen_random_uuid(), tenant_id, consumer_id, feedback_key || '-tampered', target_kind,
        stream_id, wire_run_id, finding_id, assessment_receipt_id, artifact_digest, job_key,
        definition_version, job_definition_hash, validation_policy_version_id, disposition,
        reason_code, occurred_at, record_json, record_canonical_json, record_hash
        from agent_feed.utility_feedback_events
       where tenant_id = $1 and consumer_id = $2 and feedback_key = $3`,
      [tenantId, consumerId, record.feedbackKey],
    ));

    const recommendation = normalizeOptimizationRecommendation({
      recommendationKey: "recommendation-pg-001", scope, kind: "prompt_change", proposalDigest: HASH,
      controlledReference: "ref:recommendations/prompt/pg-001", createdAt: "2026-08-20T10:30:00.000Z",
    }, { tenantId, consumerId });
    assert.equal((await repository.appendRecommendation(recommendation)).appended, true);
    assert.equal((await repository.appendRecommendation(recommendation)).appended, false);
    const approval = normalizeRecommendationApproval({
      approvalKey: "approval-pg-001", recommendationKey: recommendation.recommendationKey,
      recommendationHash: recommendation.recommendationHash, decision: "approved", decidedAt: "2026-08-20T11:00:00.000Z",
    }, recommendation, { tenantId, approverId: "owner-pg-001", allowedConsumerIds: [consumerId] });
    assert.equal((await repository.appendApproval(approval)).appended, true);
    assert.equal((await repository.appendApproval(approval)).appended, false);
    await assert.rejects(() => pool.query(
      "delete from agent_feed.optimization_recommendations where tenant_id = $1 and consumer_id = $2 and recommendation_key = $3",
      [tenantId, consumerId, recommendation.recommendationKey],
    ));

    const migration = await pool.query<{ version: string }>("select version from agent_feed.schema_migrations where version = '0007_utility_feedback'");
    assert.equal(migration.rowCount, 1);
  } finally {
    await pool.end();
  }
});
