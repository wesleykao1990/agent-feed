import assert from "node:assert/strict";
import test from "node:test";
import {
  canonicalAssessmentRequest,
  checkPolicyCompatibility,
  hashAssessmentRequest,
  normalizeAssessment,
  normalizeValidationPolicy,
  validateAssessment,
  type AssessmentSubmissionInput,
} from "../src/index.ts";

const HASH = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

function input(overrides: Partial<AssessmentSubmissionInput> = {}): AssessmentSubmissionInput {
  return {
    runId: "run-1",
    assessmentKind: "quality" as const,
    verdict: "passed" as const,
    ...overrides,
  };
}

test("normalization is fresh, UTC-canonical, and leaves authority/run status out", () => {
  const source = input({
    startedAt: "2026-01-01T09:00:00+09:00",
    completedAt: "2026-01-01T09:00:01+09:00",
    usage: [{ metric: "wall_time_ms", state: "unknown", value: null, provenance: "unknown" }],
  });
  const normalized = normalizeAssessment(source);
  assert.equal(normalized.startedAt, "2026-01-01T00:00:00.000Z");
  assert.equal(normalized.completedAt, "2026-01-01T00:00:01.000Z");
  assert.equal(normalized.usage[0]?.value, null);
  assert.equal("assessorType" in normalized, false);
  assert.equal("runStatus" in normalized, false);
  assert.equal(source.startedAt, "2026-01-01T09:00:00+09:00");
});

test("submission rejects authority and technical status fields", () => {
  for (const field of ["assessorType", "assessorIndependence", "assessorIdentity", "runStatus", "technicalRunStatus"]) {
    const result = validateAssessment({ ...input(), [field]: "independent" });
    assert.equal(result.ok, false, field);
    if (!result.ok) assert.ok(result.issues.some((issue) => issue.code === "unknown_field"), field);
  }
});

test("usage preserves unknown telemetry and enforces observed provenance/value", () => {
  assert.equal(normalizeAssessment(input({ usage: [{ metric: "input_tokens", state: "not_applicable", value: null, provenance: "unknown" }] })).usage[0]?.value, null);
  assert.throws(() => normalizeAssessment(input({ usage: [{ metric: "input_tokens", state: "unknown", value: 0, provenance: "unknown" }] })), /requires value to be null/);
  assert.throws(() => normalizeAssessment(input({ usage: [{ metric: "input_tokens", state: "observed", value: 10, provenance: "unknown" }] })), /non-unknown provenance/);
  assert.throws(() => normalizeAssessment(input({ usage: [{ metric: "input_tokens", state: "observed", value: null, provenance: "executor_measured" }] })), /requires a non-negative/);
});

test("budget limits are legal only for declared state and policy can require one", () => {
  assert.throws(() => normalizeAssessment(input({ declaredBudgets: [{ budgetKey: "tokens", state: "unknown", limit: 10 }] })), /only allowed/);
  const assessment = normalizeAssessment(input({ declaredBudgets: [{ budgetKey: "tokens", state: "declared", limit: 10 }] }));
  const policy = normalizeValidationPolicy({ requiredAssessmentKinds: ["quality"], minimumIndependence: "independent", declaredBudgetRequirement: "required" });
  const result = checkPolicyCompatibility(policy, assessment, { assessorType: "validation_service", independence: "independent" });
  assert.equal(result.compatible, true);
});

test("producer self-check cannot impersonate independent proof", () => {
  const assessment = normalizeAssessment(input());
  const policy = { requiredAssessmentKinds: ["quality" as const], minimumIndependence: "independent" as const };
  const result = checkPolicyCompatibility(policy, assessment, { assessorType: "producer_self_check", independence: "self" });
  assert.equal(result.compatible, false);
  assert.equal(result.reason, "minimum_independence_not_met");
  const impossible = checkPolicyCompatibility(policy, assessment, { assessorType: "producer_self_check", independence: "independent" });
  assert.equal(impossible.compatible, false);
  assert.equal(impossible.reason, "invalid_authority");
});

test("hash is canonical across aliases and collection order", () => {
  const first = input({
    usage: [{ metric: "output_tokens", state: "observed", value: 4, provenance: "provider_reported" }, { metric: "wall_time_ms", state: "unknown", value: null, provenance: "unknown" }],
    artifactReferences: [{ artifactKey: "report", artifactKind: "json", sha256: HASH, reference: "object://report" }],
  });
  const second: AssessmentSubmissionInput = {
    run_id: "run-1",
    assessment_kind: "quality",
    verdict: "passed",
    usage_observations: [{ metric: "wall_time_ms", state: "unknown", value: null, provenance: "unknown" }, { metric: "output_tokens", state: "observed", value: 4, provenance: "provider_reported" }],
    artifact_references: [{ artifact_key: "report", artifact_kind: "json", artifact_hash: HASH, ref: "object://report" }],
    requestIdempotencyKey: "different-key",
  };
  assert.equal(hashAssessmentRequest(first), hashAssessmentRequest(second));
  assert.equal(canonicalAssessmentRequest(first), canonicalAssessmentRequest(second));
});

test("artifact references reject inline bytes, signed URL material, and upper-case hashes", () => {
  assert.throws(() => normalizeAssessment(input({ artifactReferences: [{ artifactKey: "x", artifactKind: "text", sha256: HASH.toUpperCase(), reference: "object://x" }] })), /lower-case/);
  assert.throws(() => normalizeAssessment(input({ artifactReferences: [{ artifactKey: "x", artifactKind: "text", sha256: HASH, reference: "data:text/plain;base64,SGVsbG8=" }] })), /opaque reference/);
  assert.throws(() => normalizeAssessment(input({ artifactReferences: [{ artifactKey: "x", artifactKind: "text", sha256: HASH, reference: "https://bucket/object?X-Amz-Signature=abc" }] })), /query or fragment|credentials|signed URL/);
});
