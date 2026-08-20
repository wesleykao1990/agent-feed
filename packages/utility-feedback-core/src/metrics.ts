import { UTILITY_METRIC_VERSION, UtilityFeedbackError, type ExactRatio, type UtilityComparison, type UtilityMetricInput, type UtilityMetricSnapshot } from "./types.ts";
import { normalizeScope } from "./validation.ts";

function object(value: unknown, fields: readonly string[], issues: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) { issues.push("root:plain_object_required"); return {}; }
  const record = value as Record<string, unknown>; for (const field of Object.keys(record)) if (!fields.includes(field)) issues.push(`root.${field}:unknown_field`); return record;
}
function timestamp(value: unknown, path: string, issues: string[]): string { if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) || Number.isNaN(Date.parse(value)) || new Date(value).toISOString() !== value) { issues.push(`${path}:strict_utc_timestamp_required`); return "1970-01-01T00:00:00.000Z"; } return value; }
function count(value: unknown, path: string, issues: string[]): number { if (!Number.isSafeInteger(value) || (value as number) < 0) { issues.push(`${path}:nonnegative_safe_integer_required`); return 0; } return value as number; }
const ratio = (numerator: number, denominator: number): ExactRatio | null => denominator === 0 ? null : Object.freeze({ numerator, denominator });

export function buildUtilityMetricSnapshot(input: UtilityMetricInput): UtilityMetricSnapshot {
  const issues: string[] = [];
  const root = object(input, ["schemaVersion", "scope", "windowStart", "windowEnd", "reviewedResults", "sourcesAttempted", "acceptedResults", "actedOnResults", "reviewTimeMs", "actionLatencyMs", "costMicrounits"], issues);
  if (root.schemaVersion !== undefined && root.schemaVersion !== UTILITY_METRIC_VERSION) issues.push("schemaVersion:unsupported");
  const scope = normalizeScope(root.scope, "scope", issues); const windowStart = timestamp(root.windowStart, "windowStart", issues); const windowEnd = timestamp(root.windowEnd, "windowEnd", issues);
  if (Date.parse(windowEnd) <= Date.parse(windowStart)) issues.push("window:ordered_nonempty_required");
  const reviewedResults = count(root.reviewedResults, "reviewedResults", issues); const sourcesAttempted = count(root.sourcesAttempted, "sourcesAttempted", issues); const acceptedResults = count(root.acceptedResults, "acceptedResults", issues); const actedOnResults = count(root.actedOnResults, "actedOnResults", issues); const reviewTimeMs = count(root.reviewTimeMs, "reviewTimeMs", issues); const actionLatencyMs = count(root.actionLatencyMs, "actionLatencyMs", issues); const costMicrounits = count(root.costMicrounits, "costMicrounits", issues);
  if (acceptedResults > reviewedResults) issues.push("acceptedResults:cannot_exceed_reviewed"); if (actedOnResults > reviewedResults) issues.push("actedOnResults:cannot_exceed_reviewed"); if (actedOnResults === 0 && actionLatencyMs !== 0) issues.push("actionLatencyMs:zero_required_without_actions");
  if (issues.length) throw new UtilityFeedbackError(issues);
  return Object.freeze({ schemaVersion: UTILITY_METRIC_VERSION, scope: Object.freeze(scope), windowStart, windowEnd, reviewedResults, sourcesAttempted, acceptedResults, actedOnResults, reviewTimeMs, actionLatencyMs, costMicrounits, reviewBurden: ratio(reviewTimeMs, reviewedResults), sourceYield: ratio(acceptedResults, sourcesAttempted), timeToAction: ratio(actionLatencyMs, actedOnResults), costPerAccepted: ratio(costMicrounits, acceptedResults), costPerActedOn: ratio(costMicrounits, actedOnResults) });
}

export function compareUtilitySnapshots(baseline: UtilityMetricSnapshot, candidate: UtilityMetricSnapshot): UtilityComparison {
  if (baseline.scope.jobKey !== candidate.scope.jobKey) throw new UtilityFeedbackError(["comparison:job_key_mismatch"]);
  return Object.freeze({ jobKey: baseline.scope.jobKey, baseline, candidate, definitionChanged: baseline.scope.definitionVersion !== candidate.scope.definitionVersion || baseline.scope.jobDefinitionHash !== candidate.scope.jobDefinitionHash, policyChanged: baseline.scope.validationPolicyVersionId !== candidate.scope.validationPolicyVersionId });
}
