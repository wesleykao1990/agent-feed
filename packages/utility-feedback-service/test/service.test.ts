import assert from "node:assert/strict";
import test from "node:test";
import type { OptimizationRecommendation, RecommendationApproval, UtilityFeedbackRecord } from "@agent-feed/utility-feedback-core";
import { UtilityFeedbackService, UtilityFeedbackServiceError, type AppendResult, type UtilityFeedbackRepository } from "../src/index.ts";

const HASH = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const OWNER = { tenantId: "tenant-service", consumerId: "consumer-service" };
const SCOPE = { jobKey: "monitor-job", definitionVersion: 1, jobDefinitionHash: HASH, validationPolicyVersionId: "policy-v1" };

class MemoryRepository implements UtilityFeedbackRepository {
  feedback: UtilityFeedbackRecord[] = [];
  recommendations: OptimizationRecommendation[] = [];
  approvals: RecommendationApproval[] = [];
  async appendFeedback(record: UtilityFeedbackRecord): Promise<AppendResult<UtilityFeedbackRecord>> { this.feedback.push(record); return { record, appended: true }; }
  async appendRecommendation(record: OptimizationRecommendation): Promise<AppendResult<OptimizationRecommendation>> { this.recommendations.push(record); return { record, appended: true }; }
  async getRecommendation(tenantId: string, consumerId: string, key: string) { return this.recommendations.find((item) => item.owner.tenantId === tenantId && item.owner.consumerId === consumerId && item.recommendationKey === key) ?? null; }
  async appendApproval(record: RecommendationApproval): Promise<AppendResult<RecommendationApproval>> { this.approvals.push(record); return { record, appended: true }; }
}

test("trusted consumer context owns feedback independently of the request body", async () => {
  const repository = new MemoryRepository();
  const service = new UtilityFeedbackService(repository);
  const result = await service.recordFeedback({
    feedbackKey: "feedback-service-001",
    target: { targetKind: "finding", streamId: "monitoring", runId: "run-service-001", findingId: "finding-service-001" },
    scope: SCOPE, disposition: "surfaced", reasonCode: "relevant", occurredAt: "2026-08-20T10:00:00.000Z",
  }, { owner: OWNER });
  assert.deepEqual(result.record.owner, OWNER);
  await assert.rejects(() => service.recordFeedback({
    feedbackKey: "feedback-service-002", tenantId: "attacker",
    target: { targetKind: "finding", streamId: "monitoring", runId: "run-service-001", findingId: "finding-service-001" },
    scope: SCOPE, disposition: "ignored", reasonCode: null, occurredAt: "2026-08-20T10:00:00.000Z",
  } as never, { owner: OWNER }), /tenantId:unknown_field/u);
});

test("approval lookup is tenant and consumer scoped and cannot execute a recommendation", async () => {
  const repository = new MemoryRepository();
  const service = new UtilityFeedbackService(repository);
  const proposed = await service.proposeOptimization({
    recommendationKey: "recommendation-service-001", scope: SCOPE, kind: "prompt_change",
    proposalDigest: HASH, controlledReference: "ref:recommendations/prompt/service-001", createdAt: "2026-08-20T10:00:00.000Z",
  }, { owner: OWNER });
  assert.equal(proposed.record.approvalState, "pending");
  await assert.rejects(() => service.decideRecommendation({
    approvalKey: "approval-service-missing", recommendationKey: proposed.record.recommendationKey,
    recommendationHash: proposed.record.recommendationHash, decision: "approved", decidedAt: "2026-08-20T11:00:00.000Z",
  }, { tenantId: OWNER.tenantId, consumerId: "other-consumer", approverId: "owner-001", allowedConsumerIds: ["other-consumer"] }),
  (error: unknown) => error instanceof UtilityFeedbackServiceError && error.code === "recommendation_not_found");
  const approved = await service.decideRecommendation({
    approvalKey: "approval-service-001", recommendationKey: proposed.record.recommendationKey,
    recommendationHash: proposed.record.recommendationHash, decision: "approved", decidedAt: "2026-08-20T11:00:00.000Z",
  }, { tenantId: OWNER.tenantId, consumerId: OWNER.consumerId, approverId: "owner-001", allowedConsumerIds: [OWNER.consumerId] });
  assert.equal(approved.record.decision, "approved");
  assert.equal("apply" in approved.record, false);
});
