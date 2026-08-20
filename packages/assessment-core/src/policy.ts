import {
  ASSESSMENT_KINDS,
  type AssessmentKind,
  type AssessmentPolicyEvaluation,
  type AssessmentPolicyEvaluationInput,
  type AssessmentSubmission,
  type AssessmentSubmissionInput,
  type AssessorAuthority,
  type AssessorAuthorityInput,
  type PolicyCompatibility,
  type ValidationPolicy,
  type ValidationPolicyInput,
  type JsonValue,
} from "./types.ts";
import {
  normalizeAssessment,
  normalizeAssessorAuthority,
  normalizeValidationPolicy,
} from "./validation.ts";
import { canonicalJson, sha256Hex } from "./canonical.ts";

function compatibleResult(
  policy: ValidationPolicy,
  assessment: AssessmentSubmission,
  authority: AssessorAuthority,
): PolicyCompatibility {
  if (policy.requiredAssessmentKinds.length > 0 && !policy.requiredAssessmentKinds.includes(assessment.assessmentKind)) {
    return {
      compatible: false,
      reason: "assessment_kind_not_required",
      missingAssessmentKinds: [...policy.requiredAssessmentKinds],
      normalizedPolicy: policy,
      normalizedAssessment: assessment,
      authority,
    };
  }
  if (authority.independence === "unknown") {
    return {
      compatible: false,
      reason: "unknown_independence",
      missingAssessmentKinds: [],
      normalizedPolicy: policy,
      normalizedAssessment: assessment,
      authority,
    };
  }
  if (authority.assessorType === "producer_self_check" && authority.independence === "independent") {
    return {
      compatible: false,
      reason: "producer_cannot_claim_independence",
      missingAssessmentKinds: [],
      normalizedPolicy: policy,
      normalizedAssessment: assessment,
      authority,
    };
  }
  if (policy.minimumIndependence === "independent" && authority.independence !== "independent") {
    return {
      compatible: false,
      reason: "minimum_independence_not_met",
      missingAssessmentKinds: [],
      normalizedPolicy: policy,
      normalizedAssessment: assessment,
      authority,
    };
  }
  if (policy.minimumIndependence === "self" && authority.independence !== "self" && authority.independence !== "independent") {
    return {
      compatible: false,
      reason: "minimum_independence_not_met",
      missingAssessmentKinds: [],
      normalizedPolicy: policy,
      normalizedAssessment: assessment,
      authority,
    };
  }
  const hasDeclaredBudget = assessment.declaredBudgets.some((budget) => budget.state === "declared");
  if (policy.declaredBudgetRequirement === "required" && !hasDeclaredBudget) {
    return {
      compatible: false,
      reason: "declared_budget_required",
      missingAssessmentKinds: [],
      normalizedPolicy: policy,
      normalizedAssessment: assessment,
      authority,
    };
  }
  if (policy.declaredBudgetRequirement === "not_applicable" && assessment.declaredBudgets.some((budget) => budget.state === "declared")) {
    return {
      compatible: false,
      reason: "declared_budget_not_applicable",
      missingAssessmentKinds: [],
      normalizedPolicy: policy,
      normalizedAssessment: assessment,
      authority,
    };
  }
  return {
    compatible: true,
    reason: "compatible",
    missingAssessmentKinds: [],
    normalizedPolicy: policy,
    normalizedAssessment: assessment,
    authority,
  };
}

/**
 * Check one normalized assessment against policy and trusted authority.  The
 * authority is a separate argument by design: it cannot be supplied in the
 * assessment request or smuggled through the canonical request hash.
 */
export function checkPolicyCompatibility(
  policyInput: ValidationPolicy | ValidationPolicyInput,
  assessmentInput: AssessmentSubmission | AssessmentSubmissionInput,
  authorityInput: AssessorAuthority | AssessorAuthorityInput,
): PolicyCompatibility {
  try {
    const policy = normalizeValidationPolicy(policyInput);
    const assessment = normalizeAssessment(assessmentInput);
    const authority = normalizeAssessorAuthority(authorityInput);
    return compatibleResult(policy, assessment, authority);
  } catch (error) {
    const message = error instanceof Error ? error.message : "invalid policy compatibility input";
    const reason = message.includes("authority") || message.includes("independence") ? "invalid_authority" : message.includes("policy") ? "invalid_policy" : "invalid_assessment";
    return { compatible: false, reason, missingAssessmentKinds: [] };
  }
}

export const evaluatePolicyCompatibility = checkPolicyCompatibility;
export const isPolicyCompatible = (policy: ValidationPolicy | ValidationPolicyInput, assessment: AssessmentSubmission | AssessmentSubmissionInput, authority: AssessorAuthority | AssessorAuthorityInput): boolean => checkPolicyCompatibility(policy, assessment, authority).compatible;

/** Throw a structured error when a policy/authority gate is not satisfied. */
export function assertPolicyCompatibility(
  policyInput: ValidationPolicy | ValidationPolicyInput,
  assessmentInput: AssessmentSubmission | AssessmentSubmissionInput,
  authorityInput: AssessorAuthority | AssessorAuthorityInput,
): void {
  const result = checkPolicyCompatibility(policyInput, assessmentInput, authorityInput);
  if (!result.compatible) {
    throw new Error(`policy_incompatible:${result.reason}`);
  }
}

/**
 * Evaluate a set of assessments.  Authorities are positional to make the
 * adapter boundary explicit; a missing authority fails closed.  A policy's
 * required kinds are satisfied only by compatible assessments of each kind.
 */
export function evaluatePolicy(input: AssessmentPolicyEvaluationInput): AssessmentPolicyEvaluation {
  const policy = normalizeValidationPolicy(input.policy);
  const results: PolicyCompatibility[] = [];
  const compatibleKinds = new Set<AssessmentKind>();
  for (let index = 0; index < input.assessments.length; index += 1) {
    const assessment = input.assessments[index];
    const authority = input.authorities[index];
    if (assessment === undefined || authority === undefined) {
      results.push({ compatible: false, reason: "invalid_authority", missingAssessmentKinds: [] });
      continue;
    }
    const result = checkPolicyCompatibility(policy, assessment, authority);
    results.push(result);
    if (result.compatible && result.normalizedAssessment !== undefined) compatibleKinds.add(result.normalizedAssessment.assessmentKind);
  }
  const missingAssessmentKinds = policy.requiredAssessmentKinds.filter((kind) => !compatibleKinds.has(kind));
  return { compatible: results.every((result) => result.compatible) && missingAssessmentKinds.length === 0, missingAssessmentKinds, results };
}

export const evaluateAssessmentPolicy = evaluatePolicy;

/** Canonical policy bytes and hash are useful for immutable policy versions. */
export function canonicalValidationPolicy(input: ValidationPolicy | ValidationPolicyInput): string {
  return canonicalJson(normalizeValidationPolicy(input) as unknown as JsonValue);
}

export function hashValidationPolicy(input: ValidationPolicy | ValidationPolicyInput): string {
  return sha256Hex(canonicalValidationPolicy(input));
}

export const canonicalPolicy = canonicalValidationPolicy;
export const hashPolicy = hashValidationPolicy;

/** Exported for adapters that need to inspect the exact policy vocabulary. */
export const supportedAssessmentKinds = ASSESSMENT_KINDS;
