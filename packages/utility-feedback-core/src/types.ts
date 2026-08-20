export const UTILITY_FEEDBACK_VERSION = "agent-feed.utility-feedback.v1" as const;
export const UTILITY_METRIC_VERSION = "agent-feed.utility-metrics.v1" as const;
export const OPTIMIZATION_RECOMMENDATION_VERSION = "agent-feed.optimization-recommendation.v1" as const;
export const RECOMMENDATION_APPROVAL_VERSION = "agent-feed.recommendation-approval.v1" as const;

export const DISPOSITIONS = ["surfaced", "ignored", "duplicate", "invalid", "saved", "acted_on", "promoted", "rejected"] as const;
export type UtilityDisposition = typeof DISPOSITIONS[number];
export const REASON_CODES = ["relevant", "not_relevant", "already_known", "unsupported_claim", "insufficient_evidence", "consumer_policy", "user_saved", "user_action", "canonicalized", "review_rejected"] as const;
export type UtilityReasonCode = typeof REASON_CODES[number];

export interface ConsumerOwner { readonly tenantId: string; readonly consumerId: string; }
export interface UtilityComparisonScope {
  readonly jobKey: string;
  readonly definitionVersion: number;
  readonly jobDefinitionHash: string;
  readonly validationPolicyVersionId: string;
}
export interface FindingFeedbackTarget { readonly targetKind: "finding"; readonly streamId: string; readonly runId: string; readonly findingId: string; }
export interface ArtifactFeedbackTarget { readonly targetKind: "artifact"; readonly streamId: string; readonly runId: string; readonly assessmentReceiptId: string; readonly artifactDigest: string; }
export type UtilityFeedbackTarget = FindingFeedbackTarget | ArtifactFeedbackTarget;

export interface UtilityFeedbackInput {
  readonly schemaVersion?: string;
  readonly feedbackKey: string;
  readonly target: UtilityFeedbackTarget;
  readonly scope: UtilityComparisonScope;
  readonly disposition: UtilityDisposition;
  readonly reasonCode: UtilityReasonCode | null;
  readonly occurredAt: string;
}
export interface UtilityFeedbackRecord extends Omit<UtilityFeedbackInput, "schemaVersion"> {
  readonly schemaVersion: typeof UTILITY_FEEDBACK_VERSION;
  readonly owner: ConsumerOwner;
  readonly recordHash: string;
}
export interface AppendUtilityFeedbackResult {
  readonly records: readonly UtilityFeedbackRecord[];
  readonly record: UtilityFeedbackRecord;
  readonly appended: boolean;
}

export interface UtilityMetricInput {
  readonly schemaVersion?: string;
  readonly scope: UtilityComparisonScope;
  readonly windowStart: string;
  readonly windowEnd: string;
  readonly reviewedResults: number;
  readonly sourcesAttempted: number;
  readonly acceptedResults: number;
  readonly actedOnResults: number;
  readonly reviewTimeMs: number;
  readonly actionLatencyMs: number;
  readonly costMicrounits: number;
}
export interface ExactRatio { readonly numerator: number; readonly denominator: number; }
export interface UtilityMetricSnapshot extends Omit<UtilityMetricInput, "schemaVersion"> {
  readonly schemaVersion: typeof UTILITY_METRIC_VERSION;
  readonly reviewBurden: ExactRatio | null;
  readonly sourceYield: ExactRatio | null;
  readonly timeToAction: ExactRatio | null;
  readonly costPerAccepted: ExactRatio | null;
  readonly costPerActedOn: ExactRatio | null;
}
export interface UtilityComparison { readonly jobKey: string; readonly baseline: UtilityMetricSnapshot; readonly candidate: UtilityMetricSnapshot; readonly definitionChanged: boolean; readonly policyChanged: boolean; }

export interface OptimizationRecommendationInput {
  readonly schemaVersion?: string;
  readonly recommendationKey: string;
  readonly scope: UtilityComparisonScope;
  readonly kind: "prompt_change" | "schedule_change";
  readonly proposalDigest: string;
  readonly controlledReference: string;
  readonly createdAt: string;
}
export interface OptimizationRecommendation extends Omit<OptimizationRecommendationInput, "schemaVersion"> {
  readonly schemaVersion: typeof OPTIMIZATION_RECOMMENDATION_VERSION;
  readonly owner: ConsumerOwner;
  readonly recommendationHash: string;
  readonly approvalState: "pending";
}
export interface RecommendationApprovalAuthority { readonly tenantId: string; readonly approverId: string; readonly allowedConsumerIds: readonly string[]; }
export interface RecommendationApprovalInput { readonly schemaVersion?: string; readonly approvalKey: string; readonly recommendationKey: string; readonly recommendationHash: string; readonly decision: "approved" | "rejected"; readonly decidedAt: string; }
export interface RecommendationApproval extends Omit<RecommendationApprovalInput, "schemaVersion"> { readonly schemaVersion: typeof RECOMMENDATION_APPROVAL_VERSION; readonly tenantId: string; readonly consumerId: string; readonly approverId: string; }

export class UtilityFeedbackError extends Error {
  readonly issues: readonly string[];
  constructor(issues: readonly string[]) { super(`utility_feedback_invalid:${issues.join(";")}`); this.name = "UtilityFeedbackError"; this.issues = issues; }
}
