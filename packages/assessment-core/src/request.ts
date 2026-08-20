import type { AssessmentSubmission, AssessmentSubmissionInput, JsonValue } from "./types.ts";
import { canonicalJson, sha256Hex } from "./canonical.ts";
import { normalizeAssessment } from "./validation.ts";

/**
 * Return the exact canonical request bytes used for assessment idempotency.
 * Server-assigned IDs, timestamps, technical run status, assessor authority,
 * and request idempotency keys are not accepted by normalization and therefore
 * cannot influence this hash.
 */
export function canonicalAssessmentRequest(input: AssessmentSubmission | AssessmentSubmissionInput): string {
  return canonicalJson(normalizeAssessment(input) as unknown as JsonValue);
}

export function hashAssessmentRequest(input: AssessmentSubmission | AssessmentSubmissionInput): string {
  return sha256Hex(canonicalAssessmentRequest(input));
}

export const assessmentRequestHash = hashAssessmentRequest;
export const canonicalRequest = canonicalAssessmentRequest;
export const canonicalRequestHash = hashAssessmentRequest;
export const hashRequest = hashAssessmentRequest;
