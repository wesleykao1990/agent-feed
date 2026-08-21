import { createHash, randomUUID } from "node:crypto";
import type { Pool, QueryResultRow } from "pg";
import type {
  OptimizationRecommendation,
  RecommendationApproval,
  UtilityFeedbackRecord,
} from "@agent-feed/utility-feedback-core";
import { PersistenceError } from "./errors.ts";

export interface AppendStoredResult<T> {
  readonly record: T;
  readonly appended: boolean;
}

interface FeedbackRow extends QueryResultRow { record_json: UtilityFeedbackRecord; record_hash: string; }
interface RecommendationRow extends QueryResultRow { recommendation_json: OptimizationRecommendation; recommendation_hash: string; }
interface ApprovalRow extends QueryResultRow { approval_json: RecommendationApproval; approval_hash: string; }

function json(value: unknown): string { return JSON.stringify(value); }
function sha256(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function withoutHash<T extends Record<string, unknown>>(value: T, field: keyof T): Record<string, unknown> {
  const copy = { ...value };
  delete copy[field];
  return copy;
}
function freezeRecord<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) freezeRecord(child);
    Object.freeze(value);
  }
  return value;
}
function databaseError(error: unknown, fallback: string): never {
  if (error instanceof PersistenceError) throw error;
  const code = typeof error === "object" && error !== null && "code" in error ? String((error as { code: unknown }).code) : "";
  const message = error instanceof Error ? error.message : fallback;
  if (["23503", "23514", "22P02", "P0001"].includes(code)) {
    throw new PersistenceError("utility_feedback_validation_failed", message);
  }
  throw new PersistenceError("storage_error", fallback);
}

export class PostgresUtilityFeedbackRepository {
  readonly pool: Pool;
  constructor(pool: Pool) { this.pool = pool; }

  async appendFeedback(record: UtilityFeedbackRecord): Promise<AppendStoredResult<UtilityFeedbackRecord>> {
    const target = record.target;
    const base = withoutHash(record as unknown as Record<string, unknown>, "recordHash");
    try {
      const inserted = await this.pool.query<FeedbackRow>(
        `insert into agent_feed.utility_feedback_events (
          id, tenant_id, consumer_id, feedback_key, target_kind, stream_id, wire_run_id,
          finding_id, assessment_receipt_id, artifact_digest, job_key, definition_version,
          job_definition_hash, validation_policy_version_id, disposition, reason_code, occurred_at,
          record_json, record_canonical_json, record_hash
        ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18::jsonb,$19,$20)
        on conflict (tenant_id, consumer_id, feedback_key) do nothing
        returning record_json, record_hash`,
        [randomUUID(), record.owner.tenantId, record.owner.consumerId, record.feedbackKey, target.targetKind,
          target.streamId, target.runId, target.targetKind === "finding" ? target.findingId : null,
          target.targetKind === "artifact" ? target.assessmentReceiptId : null,
          target.targetKind === "artifact" ? target.artifactDigest : null, record.scope.jobKey,
          record.scope.definitionVersion, record.scope.jobDefinitionHash, record.scope.validationPolicyVersionId,
          record.disposition, record.reasonCode, record.occurredAt, json(record), json(base), record.recordHash],
      );
      if (inserted.rows[0]) return { record: freezeRecord(inserted.rows[0].record_json), appended: true };
      const prior = await this.getFeedback(record.owner.tenantId, record.owner.consumerId, record.feedbackKey);
      if (!prior) throw new PersistenceError("storage_error", "feedback conflict row disappeared");
      if (prior.recordHash !== record.recordHash) throw new PersistenceError("utility_feedback_conflict", "feedback key was reused with different content");
      return { record: prior, appended: false };
    } catch (error) { return databaseError(error, "utility feedback persistence failed"); }
  }

  async getFeedback(tenantId: string, consumerId: string, feedbackKey: string): Promise<UtilityFeedbackRecord | null> {
    try {
      const result = await this.pool.query<FeedbackRow>(
        `select record_json, record_hash from agent_feed.utility_feedback_events
          where tenant_id = $1 and consumer_id = $2 and feedback_key = $3`,
        [tenantId, consumerId, feedbackKey],
      );
      return result.rows[0] ? freezeRecord(result.rows[0].record_json) : null;
    } catch (error) { return databaseError(error, "utility feedback read failed"); }
  }

  async appendRecommendation(record: OptimizationRecommendation): Promise<AppendStoredResult<OptimizationRecommendation>> {
    const base = withoutHash(record as unknown as Record<string, unknown>, "recommendationHash");
    try {
      const inserted = await this.pool.query<RecommendationRow>(
        `insert into agent_feed.optimization_recommendations (
          id, tenant_id, consumer_id, recommendation_key, job_key, definition_version,
          job_definition_hash, validation_policy_version_id, recommendation_kind, proposal_digest,
          controlled_reference, created_for_at, recommendation_json, recommendation_canonical_json,
          recommendation_hash
        ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14,$15)
        on conflict (tenant_id, consumer_id, recommendation_key) do nothing
        returning recommendation_json, recommendation_hash`,
        [randomUUID(), record.owner.tenantId, record.owner.consumerId, record.recommendationKey,
          record.scope.jobKey, record.scope.definitionVersion, record.scope.jobDefinitionHash,
          record.scope.validationPolicyVersionId, record.kind, record.proposalDigest,
          record.controlledReference, record.createdAt, json(record), json(base), record.recommendationHash],
      );
      if (inserted.rows[0]) return { record: freezeRecord(inserted.rows[0].recommendation_json), appended: true };
      const prior = await this.getRecommendation(record.owner.tenantId, record.owner.consumerId, record.recommendationKey);
      if (!prior) throw new PersistenceError("storage_error", "recommendation conflict row disappeared");
      if (prior.recommendationHash !== record.recommendationHash) throw new PersistenceError("recommendation_conflict", "recommendation key was reused with different content");
      return { record: prior, appended: false };
    } catch (error) { return databaseError(error, "optimization recommendation persistence failed"); }
  }

  async getRecommendation(tenantId: string, consumerId: string, recommendationKey: string): Promise<OptimizationRecommendation | null> {
    try {
      const result = await this.pool.query<RecommendationRow>(
        `select recommendation_json, recommendation_hash from agent_feed.optimization_recommendations
          where tenant_id = $1 and consumer_id = $2 and recommendation_key = $3`,
        [tenantId, consumerId, recommendationKey],
      );
      return result.rows[0] ? freezeRecord(result.rows[0].recommendation_json) : null;
    } catch (error) { return databaseError(error, "optimization recommendation read failed"); }
  }

  async appendApproval(record: RecommendationApproval): Promise<AppendStoredResult<RecommendationApproval>> {
    const canonical = json(record);
    const hash = sha256(canonical);
    try {
      const inserted = await this.pool.query<ApprovalRow>(
        `insert into agent_feed.recommendation_approval_events (
          id, tenant_id, consumer_id, approver_id, approval_key, recommendation_key,
          recommendation_hash, decision, decided_at, approval_json, approval_canonical_json, approval_hash
        ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12)
        on conflict (tenant_id, consumer_id, approval_key) do nothing
        returning approval_json, approval_hash`,
        [randomUUID(), record.tenantId, record.consumerId, record.approverId, record.approvalKey,
          record.recommendationKey, record.recommendationHash, record.decision, record.decidedAt,
          canonical, canonical, hash],
      );
      if (inserted.rows[0]) return { record: freezeRecord(inserted.rows[0].approval_json), appended: true };
      const prior = await this.pool.query<ApprovalRow>(
        `select approval_json, approval_hash from agent_feed.recommendation_approval_events
          where tenant_id = $1 and consumer_id = $2 and approval_key = $3`,
        [record.tenantId, record.consumerId, record.approvalKey],
      );
      if (!prior.rows[0]) throw new PersistenceError("storage_error", "approval conflict row disappeared");
      if (prior.rows[0].approval_hash !== hash) throw new PersistenceError("recommendation_approval_conflict", "approval key was reused with different content");
      return { record: freezeRecord(prior.rows[0].approval_json), appended: false };
    } catch (error) { return databaseError(error, "recommendation approval persistence failed"); }
  }
}
