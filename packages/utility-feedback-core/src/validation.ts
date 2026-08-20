import { createHash } from "node:crypto";
import {
  DISPOSITIONS, OPTIMIZATION_RECOMMENDATION_VERSION, REASON_CODES, RECOMMENDATION_APPROVAL_VERSION,
  UTILITY_FEEDBACK_VERSION, UtilityFeedbackError,
  type ConsumerOwner, type OptimizationRecommendation, type OptimizationRecommendationInput,
  type RecommendationApproval, type RecommendationApprovalAuthority, type RecommendationApprovalInput,
  type UtilityComparisonScope, type UtilityFeedbackInput, type UtilityFeedbackRecord, type UtilityFeedbackTarget,
} from "./types.ts";

const KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const HASH = /^[a-f0-9]{64}$/u;
const REFERENCE = /^ref:[a-z0-9][a-z0-9._:/-]{2,255}$/u;
const SECRET_SHAPE = /(?:^|[._:/-])(api[_-]?key|bearer|credential|password|secret|token)(?:[._:/-]|$)/iu;

function object(value: unknown, path: string, fields: readonly string[], issues: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) { issues.push(`${path}:plain_object_required`); return {}; }
  const record = value as Record<string, unknown>;
  for (const field of Object.keys(record)) if (!fields.includes(field)) issues.push(`${path}.${field}:unknown_field`);
  return record;
}
function key(value: unknown, path: string, issues: string[]): string { if (typeof value !== "string" || !KEY.test(value)) { issues.push(`${path}:invalid_key`); return "invalid"; } return value; }
function hash(value: unknown, path: string, issues: string[]): string { if (typeof value !== "string" || !HASH.test(value)) { issues.push(`${path}:lowercase_sha256_required`); return "0".repeat(64); } return value; }
function timestamp(value: unknown, path: string, issues: string[]): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) || Number.isNaN(Date.parse(value)) || new Date(value).toISOString() !== value) { issues.push(`${path}:strict_utc_timestamp_required`); return "1970-01-01T00:00:00.000Z"; }
  return value;
}
function owner(value: unknown, issues: string[]): ConsumerOwner {
  const record = object(value, "owner", ["tenantId", "consumerId"], issues);
  return { tenantId: key(record.tenantId, "owner.tenantId", issues), consumerId: key(record.consumerId, "owner.consumerId", issues) };
}
export function normalizeScope(value: unknown, path: string, issues: string[]): UtilityComparisonScope {
  const record = object(value, path, ["jobKey", "definitionVersion", "jobDefinitionHash", "validationPolicyVersionId"], issues);
  if (!Number.isSafeInteger(record.definitionVersion) || (record.definitionVersion as number) < 1) issues.push(`${path}.definitionVersion:positive_safe_integer_required`);
  return { jobKey: key(record.jobKey, `${path}.jobKey`, issues), definitionVersion: Number.isSafeInteger(record.definitionVersion) ? record.definitionVersion as number : 1, jobDefinitionHash: hash(record.jobDefinitionHash, `${path}.jobDefinitionHash`, issues), validationPolicyVersionId: key(record.validationPolicyVersionId, `${path}.validationPolicyVersionId`, issues) };
}
function target(value: unknown, issues: string[]): UtilityFeedbackTarget {
  const base = object(value, "target", ["targetKind", "streamId", "runId", "findingId", "assessmentReceiptId", "artifactDigest"], issues);
  if (base.targetKind === "finding") {
    if (base.assessmentReceiptId !== undefined || base.artifactDigest !== undefined) issues.push("target:artifact_fields_not_allowed");
    return { targetKind: "finding", streamId: key(base.streamId, "target.streamId", issues), runId: key(base.runId, "target.runId", issues), findingId: key(base.findingId, "target.findingId", issues) };
  }
  if (base.targetKind === "artifact") {
    if (base.findingId !== undefined) issues.push("target:finding_fields_not_allowed");
    return { targetKind: "artifact", streamId: key(base.streamId, "target.streamId", issues), runId: key(base.runId, "target.runId", issues), assessmentReceiptId: key(base.assessmentReceiptId, "target.assessmentReceiptId", issues), artifactDigest: hash(base.artifactDigest, "target.artifactDigest", issues) };
  }
  issues.push("target.targetKind:unsupported");
  return { targetKind: "finding", streamId: "invalid", runId: "invalid", findingId: "invalid" };
}
function digest(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }

export function normalizeUtilityFeedback(input: UtilityFeedbackInput, trustedOwner: ConsumerOwner): UtilityFeedbackRecord {
  const issues: string[] = [];
  const root = object(input, "root", ["schemaVersion", "feedbackKey", "target", "scope", "disposition", "reasonCode", "occurredAt"], issues);
  if (root.schemaVersion !== undefined && root.schemaVersion !== UTILITY_FEEDBACK_VERSION) issues.push("schemaVersion:unsupported");
  const normalizedOwner = owner(trustedOwner, issues);
  const disposition = typeof root.disposition === "string" && (DISPOSITIONS as readonly string[]).includes(root.disposition) ? root.disposition as UtilityFeedbackRecord["disposition"] : (issues.push("disposition:unsupported"), "ignored");
  const reasonCode = root.reasonCode === null ? null : typeof root.reasonCode === "string" && (REASON_CODES as readonly string[]).includes(root.reasonCode) ? root.reasonCode as UtilityFeedbackRecord["reasonCode"] : (issues.push("reasonCode:unsupported"), null);
  const base = { schemaVersion: UTILITY_FEEDBACK_VERSION, feedbackKey: key(root.feedbackKey, "feedbackKey", issues), owner: normalizedOwner, target: target(root.target, issues), scope: normalizeScope(root.scope, "scope", issues), disposition, reasonCode, occurredAt: timestamp(root.occurredAt, "occurredAt", issues) };
  if (issues.length) throw new UtilityFeedbackError(issues);
  return Object.freeze({ ...base, owner: Object.freeze(base.owner), target: Object.freeze(base.target), scope: Object.freeze(base.scope), recordHash: digest(base) });
}

export function normalizeOptimizationRecommendation(input: OptimizationRecommendationInput, trustedOwner: ConsumerOwner): OptimizationRecommendation {
  const issues: string[] = [];
  const root = object(input, "root", ["schemaVersion", "recommendationKey", "scope", "kind", "proposalDigest", "controlledReference", "createdAt"], issues);
  if (root.schemaVersion !== undefined && root.schemaVersion !== OPTIMIZATION_RECOMMENDATION_VERSION) issues.push("schemaVersion:unsupported");
  const normalizedOwner = owner(trustedOwner, issues);
  const kind: OptimizationRecommendation["kind"] = root.kind === "prompt_change" || root.kind === "schedule_change" ? root.kind : (issues.push("kind:unsupported"), "prompt_change");
  if (typeof root.controlledReference !== "string" || !REFERENCE.test(root.controlledReference) || SECRET_SHAPE.test(root.controlledReference)) issues.push("controlledReference:safe_controlled_ref_required");
  const base = { schemaVersion: OPTIMIZATION_RECOMMENDATION_VERSION, recommendationKey: key(root.recommendationKey, "recommendationKey", issues), owner: normalizedOwner, scope: normalizeScope(root.scope, "scope", issues), kind, proposalDigest: hash(root.proposalDigest, "proposalDigest", issues), controlledReference: typeof root.controlledReference === "string" ? root.controlledReference : "ref:invalid", createdAt: timestamp(root.createdAt, "createdAt", issues), approvalState: "pending" as const };
  if (issues.length) throw new UtilityFeedbackError(issues);
  return Object.freeze({ ...base, owner: Object.freeze(base.owner), scope: Object.freeze(base.scope), recommendationHash: digest(base) });
}

export function normalizeRecommendationApproval(input: RecommendationApprovalInput, recommendation: OptimizationRecommendation, authorityInput: RecommendationApprovalAuthority): RecommendationApproval {
  const issues: string[] = [];
  const root = object(input, "root", ["schemaVersion", "approvalKey", "recommendationKey", "recommendationHash", "decision", "decidedAt"], issues);
  const authority = object(authorityInput, "authority", ["tenantId", "approverId", "allowedConsumerIds"], issues);
  if (root.schemaVersion !== undefined && root.schemaVersion !== RECOMMENDATION_APPROVAL_VERSION) issues.push("schemaVersion:unsupported");
  const allowed = Array.isArray(authority.allowedConsumerIds) && authority.allowedConsumerIds.every((item) => typeof item === "string" && KEY.test(item));
  if (!allowed || !(authority.allowedConsumerIds as unknown[]).includes(recommendation.owner.consumerId)) issues.push("authority:consumer_not_allowed");
  if (authority.tenantId !== recommendation.owner.tenantId) issues.push("authority:tenant_mismatch");
  if (root.recommendationKey !== recommendation.recommendationKey || root.recommendationHash !== recommendation.recommendationHash) issues.push("recommendation:identity_mismatch");
  const decision = root.decision === "approved" || root.decision === "rejected" ? root.decision : (issues.push("decision:unsupported"), "rejected");
  const result: RecommendationApproval = { schemaVersion: RECOMMENDATION_APPROVAL_VERSION, approvalKey: key(root.approvalKey, "approvalKey", issues), recommendationKey: key(root.recommendationKey, "recommendationKey", issues), recommendationHash: hash(root.recommendationHash, "recommendationHash", issues), decision, decidedAt: timestamp(root.decidedAt, "decidedAt", issues), tenantId: key(authority.tenantId, "authority.tenantId", issues), consumerId: recommendation.owner.consumerId, approverId: key(authority.approverId, "authority.approverId", issues) };
  if (issues.length) throw new UtilityFeedbackError(issues);
  return Object.freeze(result);
}
