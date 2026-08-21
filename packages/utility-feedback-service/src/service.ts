import {
  normalizeOptimizationRecommendation,
  normalizeRecommendationApproval,
  normalizeUtilityFeedback,
  type OptimizationRecommendationInput,
  type RecommendationApprovalInput,
  type UtilityFeedbackInput,
} from "@agent-feed/utility-feedback-core";
import type {
  TrustedConsumerContext,
  TrustedRecommendationApprovalContext,
  UtilityFeedbackRepository,
} from "./types.ts";
import { UtilityFeedbackServiceError } from "./types.ts";

export class UtilityFeedbackService {
  readonly #repository: UtilityFeedbackRepository;
  constructor(repository: UtilityFeedbackRepository) { this.#repository = repository; }

  async recordFeedback(input: UtilityFeedbackInput, context: TrustedConsumerContext) {
    return this.#repository.appendFeedback(normalizeUtilityFeedback(input, context.owner));
  }

  async proposeOptimization(input: OptimizationRecommendationInput, context: TrustedConsumerContext) {
    return this.#repository.appendRecommendation(normalizeOptimizationRecommendation(input, context.owner));
  }

  async decideRecommendation(input: RecommendationApprovalInput, context: TrustedRecommendationApprovalContext) {
    const recommendation = await this.#repository.getRecommendation(context.tenantId, context.consumerId, input.recommendationKey);
    if (!recommendation) throw new UtilityFeedbackServiceError("recommendation_not_found");
    const authority = {
      tenantId: context.tenantId,
      approverId: context.approverId,
      allowedConsumerIds: context.allowedConsumerIds,
    };
    return this.#repository.appendApproval(normalizeRecommendationApproval(input, recommendation, authority));
  }
}
