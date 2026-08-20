import assert from "node:assert/strict";
import test from "node:test";
import {
  appendUtilityFeedback, buildUtilityMetricSnapshot, compareUtilitySnapshots,
  normalizeOptimizationRecommendation, normalizeRecommendationApproval, normalizeUtilityFeedback,
  UtilityFeedbackError, type UtilityFeedbackInput, type UtilityMetricInput,
} from "../src/index.ts";

const HASH = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const OTHER_HASH = "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";
const OWNER = { tenantId: "tenant-m12", consumerId: "consumer-m12" };
const SCOPE = { jobKey: "monitor-job", definitionVersion: 1, jobDefinitionHash: HASH, validationPolicyVersionId: "policy-v1" };

function feedback(overrides: Partial<UtilityFeedbackInput> = {}): UtilityFeedbackInput {
  return { feedbackKey: "feedback-001", target: { targetKind: "finding", streamId: "monitoring", runId: "run-m12-001", findingId: "finding-m12-001" }, scope: SCOPE, disposition: "surfaced", reasonCode: "relevant", occurredAt: "2026-08-20T10:00:00.000Z", ...overrides };
}
function metric(overrides: Partial<UtilityMetricInput> = {}): UtilityMetricInput {
  return { scope: SCOPE, windowStart: "2026-08-01T00:00:00.000Z", windowEnd: "2026-08-20T00:00:00.000Z", reviewedResults: 10, sourcesAttempted: 20, acceptedResults: 4, actedOnResults: 2, reviewTimeMs: 1000, actionLatencyMs: 4000, costMicrounits: 800, ...overrides };
}

test("consumer ownership is trusted context and normalized records are deeply immutable", () => {
  const record = normalizeUtilityFeedback(feedback(), OWNER);
  assert.deepEqual(record.owner, OWNER);
  assert.equal(record.recordHash.length, 64);
  assert.throws(() => (record.owner as { consumerId: string }).consumerId = "changed", TypeError);
  assert.throws(() => normalizeUtilityFeedback({ ...feedback(), tenantId: "attacker" } as never, OWNER), /tenantId:unknown_field/u);
});

test("finding and artifact feedback contain identity only and reject payload fields", () => {
  const artifact = normalizeUtilityFeedback(feedback({ feedbackKey: "artifact-001", target: { targetKind: "artifact", streamId: "monitoring", runId: "run-m12-001", assessmentReceiptId: "assessment-001", artifactDigest: HASH }, disposition: "saved", reasonCode: "user_saved" }), OWNER);
  assert.equal(artifact.target.targetKind, "artifact");
  assert.throws(() => normalizeUtilityFeedback(feedback({ target: { targetKind: "finding", streamId: "monitoring", runId: "run-m12-001", findingId: "finding-m12-001", summary: "rewrite" } as never }), OWNER), /summary:unknown_field/u);
  assert.throws(() => normalizeUtilityFeedback(feedback({ target: { targetKind: "artifact", streamId: "monitoring", runId: "run-m12-001", assessmentReceiptId: "assessment-001", artifactDigest: "bad" } }), OWNER), /lowercase_sha256_required/u);
});

test("append is idempotent and conflicting key reuse cannot rewrite history", () => {
  const first = appendUtilityFeedback([], feedback(), OWNER);
  const retry = appendUtilityFeedback(first.records, feedback(), OWNER);
  assert.equal(first.appended, true); assert.equal(retry.appended, false); assert.equal(retry.record, first.record);
  assert.throws(() => appendUtilityFeedback(first.records, feedback({ disposition: "rejected", reasonCode: "review_rejected" }), OWNER), /idempotency_payload_conflict/u);
  assert.throws(() => appendUtilityFeedback([{ ...first.record }] as never, feedback({ feedbackKey: "feedback-002" }), OWNER), /normalized_immutable_record_required/u);
  assert.equal(first.records[0]!.disposition, "surfaced");
});

test("bounded utility metrics preserve exact ratios and zero-denominator absence", () => {
  const snapshot = buildUtilityMetricSnapshot(metric());
  assert.deepEqual(snapshot.reviewBurden, { numerator: 1000, denominator: 10 });
  assert.deepEqual(snapshot.sourceYield, { numerator: 4, denominator: 20 });
  assert.deepEqual(snapshot.timeToAction, { numerator: 4000, denominator: 2 });
  const empty = buildUtilityMetricSnapshot(metric({ reviewedResults: 0, sourcesAttempted: 0, acceptedResults: 0, actedOnResults: 0, reviewTimeMs: 0, actionLatencyMs: 0, costMicrounits: 0 }));
  assert.equal(empty.reviewBurden, null); assert.equal(empty.costPerAccepted, null);
  assert.throws(() => buildUtilityMetricSnapshot(metric({ reviewedResults: 1, acceptedResults: 2 })), /cannot_exceed_reviewed/u);
  assert.throws(() => buildUtilityMetricSnapshot(metric({ costMicrounits: Number.MAX_SAFE_INTEGER + 1 })), /safe_integer/u);
});

test("comparisons retain exact definition and policy scopes", () => {
  const baseline = buildUtilityMetricSnapshot(metric());
  const candidate = buildUtilityMetricSnapshot(metric({ scope: { ...SCOPE, definitionVersion: 2, jobDefinitionHash: OTHER_HASH, validationPolicyVersionId: "policy-v2" } }));
  const comparison = compareUtilitySnapshots(baseline, candidate);
  assert.equal(comparison.definitionChanged, true); assert.equal(comparison.policyChanged, true);
  assert.equal(comparison.baseline.scope.definitionVersion, 1); assert.equal(comparison.candidate.scope.definitionVersion, 2);
  assert.throws(() => compareUtilitySnapshots(baseline, buildUtilityMetricSnapshot(metric({ scope: { ...SCOPE, jobKey: "other-job" } }))), /job_key_mismatch/u);
});

test("prompt and schedule recommendations require separate authorized approval", () => {
  const recommendation = normalizeOptimizationRecommendation({ recommendationKey: "recommendation-001", scope: SCOPE, kind: "prompt_change", proposalDigest: HASH, controlledReference: "ref:recommendations/prompt/001", createdAt: "2026-08-20T10:00:00.000Z" }, OWNER);
  assert.equal(recommendation.approvalState, "pending");
  assert.throws(() => normalizeOptimizationRecommendation({ recommendationKey: "recommendation-002", scope: SCOPE, kind: "schedule_change", proposalDigest: HASH, controlledReference: "ref:recommendations/schedule/002", createdAt: "2026-08-20T10:00:00.000Z", schedule: "* * * * *" } as never, OWNER), /schedule:unknown_field/u);
  assert.throws(() => normalizeOptimizationRecommendation({ recommendationKey: "recommendation-003", scope: SCOPE, kind: "prompt_change", proposalDigest: HASH, controlledReference: "ref:recommendations/token/secret", createdAt: "2026-08-20T10:00:00.000Z" }, OWNER), /safe_controlled_ref_required/u);
  const approval = normalizeRecommendationApproval({ approvalKey: "approval-001", recommendationKey: recommendation.recommendationKey, recommendationHash: recommendation.recommendationHash, decision: "approved", decidedAt: "2026-08-20T11:00:00.000Z" }, recommendation, { tenantId: OWNER.tenantId, approverId: "owner-001", allowedConsumerIds: [OWNER.consumerId] });
  assert.equal(approval.decision, "approved"); assert.equal(approval.approverId, "owner-001");
  assert.throws(() => normalizeRecommendationApproval({ approvalKey: "approval-002", recommendationKey: recommendation.recommendationKey, recommendationHash: recommendation.recommendationHash, decision: "approved", decidedAt: "2026-08-20T11:00:00.000Z" }, recommendation, { tenantId: OWNER.tenantId, approverId: "owner-002", allowedConsumerIds: ["other-consumer"] }), (error: unknown) => error instanceof UtilityFeedbackError && /consumer_not_allowed/u.test(error.message));
});
