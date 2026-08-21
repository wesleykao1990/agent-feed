import type {
  ConsumerOwner,
  OptimizationRecommendation,
  RecommendationApproval,
  RecommendationApprovalAuthority,
  UtilityFeedbackRecord,
} from "@agent-feed/utility-feedback-core";

export interface AppendResult<T> { readonly record: T; readonly appended: boolean; }

export interface UtilityFeedbackRepository {
  appendFeedback(record: UtilityFeedbackRecord): Promise<AppendResult<UtilityFeedbackRecord>>;
  appendRecommendation(record: OptimizationRecommendation): Promise<AppendResult<OptimizationRecommendation>>;
  getRecommendation(tenantId: string, consumerId: string, recommendationKey: string): Promise<OptimizationRecommendation | null>;
  appendApproval(record: RecommendationApproval): Promise<AppendResult<RecommendationApproval>>;
}

/** Authenticated identity supplied by a trusted transport, never request JSON. */
export interface TrustedConsumerContext { readonly owner: ConsumerOwner; }

/** The route/composition root fixes the consumer being approved. */
export interface TrustedRecommendationApprovalContext extends RecommendationApprovalAuthority {
  readonly consumerId: string;
}

export type UtilityFeedbackServiceErrorCode = "recommendation_not_found";
export class UtilityFeedbackServiceError extends Error {
  readonly code: UtilityFeedbackServiceErrorCode;
  constructor(code: UtilityFeedbackServiceErrorCode) { super(code); this.name = "UtilityFeedbackServiceError"; this.code = code; }
}
