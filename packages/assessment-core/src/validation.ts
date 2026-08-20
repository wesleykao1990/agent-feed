import {
  ASSESSMENT_KINDS,
  ASSESSMENT_SCHEMA_VERSION,
  ASSESSOR_TYPES,
  ASSESSOR_INDEPENDENCE_VALUES,
  DECLARED_BUDGET_REQUIREMENTS,
  DECLARED_BUDGET_STATES,
  FAILURE_CLASSES,
  FAILURE_STAGES,
  MAX_ARTIFACT_REFERENCES,
  MAX_BUDGET_DECLARATIONS,
  MAX_IDENTIFIER_LENGTH,
  MAX_METADATA_ARRAY_LENGTH,
  MAX_METADATA_DEPTH,
  MAX_METADATA_KEYS,
  MAX_METADATA_STRING_LENGTH,
  MAX_OPAQUE_REFERENCE_LENGTH,
  MAX_POLICY_KINDS,
  MAX_SUMMARY_LENGTH,
  MAX_USAGE_OBSERVATIONS,
  STOP_REASONS,
  TELEMETRY_STATES,
  USAGE_METRICS,
  USAGE_PROVENANCE_TYPES,
  VALIDATION_POLICY_SCHEMA_VERSION,
  AssessmentCoreError,
  type ArtifactReference,
  type ArtifactReferenceInput,
  type AssessmentSubmission,
  type AssessmentSubmissionInput,
  type AssessmentKind,
  type AssessorAuthority,
  type AssessorAuthorityInput,
  type AssessorIndependence,
  type AssessorType,
  type DeclaredBudget,
  type DeclaredBudgetInput,
  type DeclaredBudgetRequirement,
  type DeclaredBudgetState,
  type FailureClass,
  type FailureStage,
  type JsonObject,
  type JsonValue,
  type StopReason,
  type TelemetryState,
  type UsageMetric,
  type UsageObservation,
  type UsageObservationInput,
  type UsageProvenanceType,
  type ValidationPolicy,
  type ValidationPolicyInput,
  type ValidationIssue,
  type ValidationResult,
  type ValidationError,
} from "./types.ts";

const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:?\d{2})$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const CONTROL_PATTERN = /[\u0000-\u001f\u007f]/u;
const BASE64_PATTERN = /^(?:data:[^,]*;base64,|[A-Za-z0-9+/]{32,}={0,2})$/u;
const CREDENTIAL_VALUE_PATTERNS: readonly RegExp[] = [
  /\b(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/iu,
  /\bAWS4-HMAC-SHA256\b/iu,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/u,
  /\b(?:gh[pousr]|github_pat)_[A-Za-z0-9_]{20,}\b/u,
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{16,}\b/u,
  /\bAIza[0-9A-Za-z_-]{20,}\b/u,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/u,
  /\b(?:pk|rk|sk)_(?:live|test)_[0-9A-Za-z]{16,}\b/u,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/u,
];
const SENSITIVE_KEY_PARTS = [
  "authorization", "credential", "password", "secret", "token", "privatekey", "apikey", "accesskey",
  "signedurl", "signature", "inline", "blob", "base64", "payload", "content", "raw", "body",
  "assessoridentity", "assessorid", "assessortype", "independence", "trustedkey", "subjectdigest",
  "runstatus", "technicalstatus", "technicalcompletion",
];

const POLICY_FIELDS = new Set([
  "schemaVersion", "policyKey", "policyVersion", "policy_key", "policy_version", "requiredAssessmentKinds",
  "required_assessment_kinds", "requiredKinds", "minimumIndependence", "minimum_independence",
  "minimumAssessorIndependence", "minimum_assessor_independence", "declaredBudgetRequirement",
  "declared_budget_requirement", "budgetRequirement", "budget_requirement", "declaredBudgetRequirements",
  "declared_budget_requirements", "metadata",
]);
const ASSESSMENT_FIELDS = new Set([
  "schemaVersion", "runId", "run_id", "policyKey", "policyVersion", "policy_key", "policy_version",
  "assessmentKind", "assessment_kind", "kind", "verdict", "failureStage", "failure_stage", "failureClass",
  "failure_class", "stopReason", "stop_reason", "startedAt", "started_at", "completedAt", "completed_at",
  "summary", "metadata", "declaredBudgets", "declared_budgets", "usage", "usageObservations",
  "usage_observations", "artifactReferences", "artifact_references", "requestIdempotencyKey",
  "request_idempotency_key",
]);
const BUDGET_FIELDS = new Set([
  "budgetKey", "budget_key", "state", "budgetState", "budget_state", "limit", "limitValue", "limit_value",
  "unit", "metadata",
]);
const USAGE_FIELDS = new Set([
  "metric", "usageKey", "usage_key", "state", "telemetryState", "telemetry_state", "value", "provenance", "usageProvenance",
  "usage_provenance", "provenanceDetails", "provenance_details", "unit", "observedAt", "observed_at", "metadata",
]);
const ARTIFACT_FIELDS = new Set([
  "artifactKey", "artifact_key", "key", "artifactKind", "artifact_kind", "kind", "sha256", "artifactHash",
  "artifact_hash", "hash", "identity", "reference", "ref", "artifactRef", "artifact_ref", "byteLength", "byte_length",
  "sizeBytes", "size_bytes", "mediaType", "media_type", "provenance", "metadata",
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function issue(issues: ValidationIssue[], code: string, path: string, message: string): void {
  issues.push({ code, path, message });
}

function firstDefined<T>(...values: readonly (T | undefined)[]): T | undefined {
  return values.find((value): value is T => value !== undefined);
}

function equalAliasValues(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

function aliased<T>(input: Record<string, unknown>, names: readonly string[], path: string, issues: ValidationIssue[]): T | undefined {
  const present = names.filter((name) => input[name] !== undefined).map((name) => input[name]);
  if (present.length > 1 && present.slice(1).some((value) => !equalAliasValues(present[0], value))) {
    issue(issues, "invalid_assessment", path, `${path} has conflicting aliases`);
  }
  return present[0] as T | undefined;
}

function rejectUnknownFields(input: Record<string, unknown>, allowed: ReadonlySet<string>, path: string, issues: ValidationIssue[]): void {
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) issue(issues, "unknown_field", `${path}.${key}`, `${path}.${key} is not accepted by this contract`);
  }
}

function requiredText(value: unknown, path: string, issues: ValidationIssue[], maxLength: number = MAX_IDENTIFIER_LENGTH): string | undefined {
  if (typeof value !== "string" || value.trim().length === 0) {
    issue(issues, "required_string", path, `${path} must be a non-empty string`);
    return undefined;
  }
  const normalized = value.trim();
  if (normalized.length > maxLength) issue(issues, "required_string", path, `${path} exceeds the ${maxLength}-character limit`);
  if (CONTROL_PATTERN.test(normalized)) issue(issues, "required_string", path, `${path} contains control characters`);
  return normalized;
}

function optionalText(value: unknown, path: string, issues: ValidationIssue[], maxLength: number = MAX_IDENTIFIER_LENGTH): string | null | undefined {
  if (value === undefined || value === null) return value === null ? null : undefined;
  return requiredText(value, path, issues, maxLength);
}

function enumValue<T extends string>(value: unknown, values: readonly T[], path: string, issues: ValidationIssue[]): T | undefined {
  if (typeof value === "string" && (values as readonly string[]).includes(value)) return value as T;
  issue(issues, "invalid_enum", path, `${path} is not a supported value`);
  return undefined;
}

function normalizedTimestamp(value: unknown, path: string, issues: ValidationIssue[]): string | null | undefined {
  if (value === undefined || value === null) return value === null ? null : undefined;
  if (typeof value !== "string" || !ISO_DATE_PATTERN.test(value)) {
    issue(issues, "invalid_timestamp", path, `${path} must be an ISO timestamp with an explicit timezone`);
    return undefined;
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    issue(issues, "invalid_timestamp", path, `${path} is not a valid instant`);
    return undefined;
  }
  return new Date(parsed).toISOString();
}

function safeNumber(value: unknown, path: string, issues: ValidationIssue[], allowNull = true): number | null | undefined {
  if (value === null && allowNull) return null;
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    issue(issues, "usage_value_invalid", path, `${path} must be a non-negative safe integer or null`);
    return undefined;
  }
  return value as number;
}

function sensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/gu, "");
  return SENSITIVE_KEY_PARTS.some((part) => normalized.includes(part));
}

function sensitiveValue(value: string): boolean {
  if (CONTROL_PATTERN.test(value)) return true;
  if (CREDENTIAL_VALUE_PATTERNS.some((pattern) => pattern.test(value))) return true;
  if (/\b[a-z][a-z0-9+.-]*:\/\/[^\s/?#@]+@/iu.test(value)) return true;
  return false;
}

function normalizeJson(value: unknown, path: string, issues: ValidationIssue[], depth: number): JsonValue | undefined {
  if (depth > MAX_METADATA_DEPTH) {
    issue(issues, "metadata_limit_exceeded", path, `metadata exceeds the ${MAX_METADATA_DEPTH}-level depth limit`);
    return undefined;
  }
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (value.length > MAX_METADATA_STRING_LENGTH) issue(issues, "metadata_limit_exceeded", path, `${path} exceeds the string limit`);
    if (sensitiveValue(value)) issue(issues, "credential_like_content", path, `${path} contains credential-like content`);
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value) || !Number.isSafeInteger(value)) issue(issues, "invalid_metadata", path, `${path} must be a finite safe integer`);
    return Number.isFinite(value) && Number.isSafeInteger(value) ? value : undefined;
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_METADATA_ARRAY_LENGTH) issue(issues, "metadata_limit_exceeded", path, `${path} exceeds the array limit`);
    const result: JsonValue[] = [];
    for (let index = 0; index < value.length; index += 1) {
      const child = normalizeJson(value[index], `${path}[${index}]`, issues, depth + 1);
      if (child !== undefined) result.push(child);
    }
    return result;
  }
  if (!isPlainObject(value)) {
    issue(issues, "invalid_metadata", path, `${path} must contain plain JSON objects only`);
    return undefined;
  }
  const keys = Object.keys(value);
  if (keys.length > MAX_METADATA_KEYS) issue(issues, "metadata_limit_exceeded", path, `${path} exceeds the object key limit`);
  const result: Record<string, JsonValue> = {};
  for (const key of keys) {
    if (sensitiveKey(key)) issue(issues, "credential_like_content", `${path}.${key}`, `${path}.${key} is not permitted in metadata`);
    const child = normalizeJson(value[key], `${path}.${key}`, issues, depth + 1);
    if (child !== undefined) result[key] = child;
  }
  return result;
}

function metadata(value: unknown, path: string, issues: ValidationIssue[]): JsonObject {
  if (value === undefined) return {};
  if (!isPlainObject(value)) {
    issue(issues, "invalid_metadata", path, `${path} must be a plain JSON object`);
    return {};
  }
  const normalized = normalizeJson(value, path, issues, 0);
  return isPlainObject(normalized) ? normalized as JsonObject : {};
}

function validationError(issues: readonly ValidationIssue[], fallbackCode: string, fallbackMessage: string): ValidationError {
  const first = issues[0];
  return {
    code: first?.code ?? fallbackCode,
    message: first?.message ?? fallbackMessage,
    ...(first?.path === undefined ? {} : { path: first.path }),
  };
}

function throwValidation<T>(result: ValidationResult<T>): T {
  if (result.ok) return result.value;
  throw new AssessmentCoreError(String(result.error.code), result.error.message, {
    ...(result.error.path === undefined ? {} : { path: result.error.path }),
    issues: result.issues,
  });
}

/** Validate and normalize an immutable validation policy. */
export function validateValidationPolicy(input: ValidationPolicyInput): ValidationResult<ValidationPolicy> {
  const issues: ValidationIssue[] = [];
  if (!isPlainObject(input)) {
    issue(issues, "invalid_object", "policy", "policy must be a plain object");
    return { ok: false, error: validationError(issues, "invalid_policy", "invalid validation policy"), issues };
  }
  rejectUnknownFields(input, POLICY_FIELDS, "policy", issues);
  if (input.schemaVersion !== undefined && input.schemaVersion !== VALIDATION_POLICY_SCHEMA_VERSION) {
    issue(issues, "invalid_schema_version", "policy.schemaVersion", `policy.schemaVersion must be ${VALIDATION_POLICY_SCHEMA_VERSION}`);
  }
  const policyKey = optionalText(aliased(input, ["policyKey", "policy_key"], "policy.policyKey", issues), "policy.policyKey", issues);
  const policyVersion = optionalText(aliased(input, ["policyVersion", "policy_version"], "policy.policyVersion", issues), "policy.policyVersion", issues);
  const kindValue = aliased<readonly unknown[]>(input, ["requiredAssessmentKinds", "required_assessment_kinds", "requiredKinds"], "policy.requiredAssessmentKinds", issues);
  if (kindValue !== undefined && !Array.isArray(kindValue)) issue(issues, "invalid_policy", "policy.requiredAssessmentKinds", "requiredAssessmentKinds must be an array");
  const kindList = Array.isArray(kindValue) ? kindValue : [];
  if (kindList.length > MAX_POLICY_KINDS) issue(issues, "metadata_limit_exceeded", "policy.requiredAssessmentKinds", `requiredAssessmentKinds exceeds ${MAX_POLICY_KINDS}`);
  const requiredKinds: AssessmentKind[] = [];
  for (let index = 0; index < kindList.length; index += 1) {
    const kind = enumValue(kindList[index], ASSESSMENT_KINDS, `policy.requiredAssessmentKinds[${index}]`, issues);
    if (kind !== undefined && !requiredKinds.includes(kind)) requiredKinds.push(kind);
  }
  const minValue = aliased<unknown>(input, ["minimumIndependence", "minimum_independence", "minimumAssessorIndependence", "minimum_assessor_independence"], "policy.minimumIndependence", issues);
  if (minValue !== "self" && minValue !== "independent") issue(issues, "invalid_policy", "policy.minimumIndependence", "minimumIndependence must be self or independent");
  const budgetValue = aliased<unknown>(input, ["declaredBudgetRequirement", "declared_budget_requirement", "budgetRequirement", "budget_requirement"], "policy.declaredBudgetRequirement", issues);
  const budgetObject = aliased<unknown>(input, ["declaredBudgetRequirements", "declared_budget_requirements"], "policy.declaredBudgetRequirements", issues);
  let budgetRequirement: DeclaredBudgetRequirement | undefined;
  if (budgetValue !== undefined) {
    budgetRequirement = enumValue(budgetValue, DECLARED_BUDGET_REQUIREMENTS, "policy.declaredBudgetRequirement", issues);
  } else if (budgetObject !== undefined) {
    if (!isPlainObject(budgetObject)) {
      issue(issues, "invalid_policy", "policy.declaredBudgetRequirements", "declaredBudgetRequirements must be a plain object");
    } else {
      const state = budgetObject.state;
      const required = budgetObject.required;
      if (state === "required" || required === true) budgetRequirement = "required";
      else if (state === "not_applicable") budgetRequirement = "not_applicable";
      else if (state === "optional" || required === false || state === undefined) budgetRequirement = "optional";
      else issue(issues, "invalid_policy", "policy.declaredBudgetRequirements.state", "declaredBudgetRequirements.state is invalid");
      for (const key of Object.keys(budgetObject)) {
        if (key !== "state" && key !== "required") issue(issues, "unknown_field", `policy.declaredBudgetRequirements.${key}`, "only state and required are accepted");
      }
    }
  } else {
    budgetRequirement = "optional";
  }
  const normalizedMetadata = metadata(input.metadata, "policy.metadata", issues);
  if (issues.length > 0 || minValue === undefined || budgetRequirement === undefined) {
    return { ok: false, error: validationError(issues, "invalid_policy", "invalid validation policy"), issues };
  }
  return {
    ok: true,
    value: {
      schemaVersion: VALIDATION_POLICY_SCHEMA_VERSION,
      policyKey: policyKey ?? null,
      policyVersion: policyVersion ?? null,
      requiredAssessmentKinds: requiredKinds,
      minimumIndependence: minValue as "self" | "independent",
      declaredBudgetRequirement: budgetRequirement ?? "optional",
      metadata: normalizedMetadata,
    },
    issues: [],
  };
}

export function normalizeValidationPolicy(input: ValidationPolicyInput | ValidationPolicy): ValidationPolicy {
  return throwValidation(validateValidationPolicy(input));
}

export const validatePolicy = validateValidationPolicy;
export const normalizePolicy = normalizeValidationPolicy;

function normalizeBudget(input: unknown, index: number, issues: ValidationIssue[]): DeclaredBudget | undefined {
  const path = `assessment.declaredBudgets[${index}]`;
  if (!isPlainObject(input)) {
    issue(issues, "invalid_budget", path, `${path} must be a plain object`);
    return undefined;
  }
  rejectUnknownFields(input, BUDGET_FIELDS, path, issues);
  const budgetKey = requiredText(aliased(input, ["budgetKey", "budget_key"], `${path}.budgetKey`, issues), `${path}.budgetKey`, issues);
  const state = enumValue(aliased<unknown>(input, ["state", "budgetState", "budget_state"], `${path}.state`, issues), DECLARED_BUDGET_STATES, `${path}.state`, issues);
  const limitValue = aliased<unknown>(input, ["limit", "limitValue", "limit_value"], `${path}.limit`, issues);
  const limit = limitValue === undefined ? null : safeNumber(limitValue, `${path}.limit`, issues);
  if (state !== "declared" && limitValue !== undefined && limit !== null) issue(issues, "budget_limit_not_allowed", `${path}.limit`, "a budget limit is only allowed when state is declared");
  if (state === "declared" && (limitValue === undefined || limit === null || limit === undefined)) issue(issues, "budget_limit_invalid", `${path}.limit`, "declared budgets require a non-negative safe-integer limit");
  const unit = optionalText(input.unit, `${path}.unit`, issues, 128);
  const normalizedMetadata = metadata(input.metadata, `${path}.metadata`, issues);
  if (budgetKey === undefined || state === undefined || limit === undefined || issues.some((entry) => entry.path.startsWith(path))) return undefined;
  return { budgetKey, state, limit, unit: unit ?? null, metadata: normalizedMetadata };
}

function normalizeBudgets(value: unknown, issues: ValidationIssue[]): DeclaredBudget[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    issue(issues, "invalid_budget", "assessment.declaredBudgets", "declaredBudgets must be an array");
    return [];
  }
  if (value.length > MAX_BUDGET_DECLARATIONS) issue(issues, "budget_limit_exceeded", "assessment.declaredBudgets", `declaredBudgets exceeds ${MAX_BUDGET_DECLARATIONS}`);
  const result: DeclaredBudget[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < value.length; index += 1) {
    const budget = normalizeBudget(value[index], index, issues);
    if (budget === undefined) continue;
    if (seen.has(budget.budgetKey)) issue(issues, "duplicate_budget", `assessment.declaredBudgets[${index}].budgetKey`, `duplicate budget key ${budget.budgetKey}`);
    seen.add(budget.budgetKey);
    result.push(budget);
  }
  return result.sort((a, b) => a.budgetKey.localeCompare(b.budgetKey) || a.state.localeCompare(b.state));
}

function normalizeUsage(input: unknown, index: number, issues: ValidationIssue[]): UsageObservation | undefined {
  const path = `assessment.usage[${index}]`;
  if (!isPlainObject(input)) {
    issue(issues, "invalid_usage", path, `${path} must be a plain object`);
    return undefined;
  }
  rejectUnknownFields(input, USAGE_FIELDS, path, issues);
  const metric = enumValue(input.metric, USAGE_METRICS, `${path}.metric`, issues);
  const state = enumValue(aliased<unknown>(input, ["state", "telemetryState", "telemetry_state"], `${path}.state`, issues), TELEMETRY_STATES, `${path}.state`, issues);
  const provenance = enumValue(aliased<unknown>(input, ["provenance", "usageProvenance", "usage_provenance"], `${path}.provenance`, issues), USAGE_PROVENANCE_TYPES, `${path}.provenance`, issues);
  const rawValue = input.value;
  const value = rawValue === undefined ? null : safeNumber(rawValue, `${path}.value`, issues);
  if (state === "observed") {
    if (value === null || value === undefined) issue(issues, "usage_value_not_allowed", `${path}.value`, "observed telemetry requires a non-negative safe-integer value");
    if (provenance === undefined || provenance === "unknown") issue(issues, "usage_provenance_invalid", `${path}.provenance`, "observed telemetry requires non-unknown provenance");
  } else if ((state === "unknown" || state === "not_applicable") && rawValue !== undefined && value !== null) {
    issue(issues, "usage_value_not_allowed", `${path}.value`, `${state} telemetry requires value to be null`);
  }
  const usageKey = optionalText(aliased(input, ["usageKey", "usage_key"], `${path}.usageKey`, issues), `${path}.usageKey`, issues);
  const provenanceDetails = metadata(aliased(input, ["provenanceDetails", "provenance_details"], `${path}.provenanceDetails`, issues), `${path}.provenanceDetails`, issues);
  const unit = optionalText(input.unit, `${path}.unit`, issues, 128);
  const observedAt = normalizedTimestamp(aliased(input, ["observedAt", "observed_at"], `${path}.observedAt`, issues), `${path}.observedAt`, issues);
  const normalizedMetadata = metadata(input.metadata, `${path}.metadata`, issues);
  const observedAtInvalid = (input.observedAt !== undefined || input.observed_at !== undefined) && observedAt === undefined;
  if (metric === undefined || state === undefined || provenance === undefined || value === undefined || observedAtInvalid || issues.some((entry) => entry.path.startsWith(path))) return undefined;
  return {
    metric,
    ...(usageKey === undefined || usageKey === null ? {} : { usageKey }),
    state,
    value,
    provenance,
    ...(input.provenanceDetails !== undefined || input.provenance_details !== undefined ? { provenanceDetails } : {}),
    unit: unit ?? null,
    ...(observedAt === undefined || observedAt === null ? (observedAt === null ? { observedAt: null } : {}) : { observedAt }),
    metadata: normalizedMetadata,
  };
}

function usageEntries(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (!isPlainObject(value)) return [];
  return Object.entries(value).map(([metric, observation]) => {
    if (isPlainObject(observation)) return { ...observation, metric: (observation.metric as unknown) ?? metric };
    return { metric, value: observation };
  });
}

function normalizeUsageList(value: unknown, issues: ValidationIssue[]): UsageObservation[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) && !isPlainObject(value)) {
    issue(issues, "invalid_usage", "assessment.usage", "usage must be an array or metric-keyed object");
    return [];
  }
  const entries = usageEntries(value);
  if (entries.length > MAX_USAGE_OBSERVATIONS) issue(issues, "usage_limit_exceeded", "assessment.usage", `usage exceeds ${MAX_USAGE_OBSERVATIONS}`);
  const result: UsageObservation[] = [];
  const seen = new Set<UsageMetric>();
  for (let index = 0; index < entries.length; index += 1) {
    const observation = normalizeUsage(entries[index], index, issues);
    if (observation === undefined) continue;
    if (seen.has(observation.metric)) issue(issues, "duplicate_usage_metric", `assessment.usage[${index}].metric`, `duplicate usage metric ${observation.metric}`);
    seen.add(observation.metric);
    result.push(observation);
  }
  return result.sort((a, b) => a.metric.localeCompare(b.metric));
}

function artifactReferenceText(value: unknown, path: string, issues: ValidationIssue[]): string | undefined {
  const text = requiredText(value, path, issues, MAX_OPAQUE_REFERENCE_LENGTH);
  if (text === undefined) return undefined;
  if (text.includes("?") || text.includes("#")) issue(issues, "invalid_artifact_reference", path, `${path} must not contain a query or fragment`);
  if (/^data:/iu.test(text) || BASE64_PATTERN.test(text)) issue(issues, "artifact_content_forbidden", path, `${path} must be an opaque reference, not inline/base64 content`);
  if (sensitiveValue(text) || /(?:[?&](?:x-amz-|signature|sig|token|expires|credential|apikey)=|(?:signed|presign|presigned))/iu.test(text)) {
    issue(issues, "credential_like_content", path, `${path} must not contain credentials or signed URL material`);
  }
  return text;
}

function optionalArtifactReferenceText(value: unknown, path: string, issues: ValidationIssue[]): string | null | undefined {
  if (value === undefined || value === null) return value === null ? null : undefined;
  return artifactReferenceText(value, path, issues);
}

function normalizeArtifact(input: unknown, index: number, issues: ValidationIssue[]): ArtifactReference | undefined {
  const path = `assessment.artifactReferences[${index}]`;
  if (!isPlainObject(input)) {
    issue(issues, "invalid_artifact", path, `${path} must be a plain object`);
    return undefined;
  }
  rejectUnknownFields(input, ARTIFACT_FIELDS, path, issues);
  const artifactKey = artifactReferenceText(aliased(input, ["artifactKey", "artifact_key", "key"], `${path}.artifactKey`, issues), `${path}.artifactKey`, issues);
  const artifactKind = artifactReferenceText(aliased(input, ["artifactKind", "artifact_kind", "kind"], `${path}.artifactKind`, issues), `${path}.artifactKind`, issues);
  const sha256 = requiredText(aliased(input, ["sha256", "artifactHash", "artifact_hash", "hash"], `${path}.sha256`, issues), `${path}.sha256`, issues, 64);
  if (sha256 !== undefined && !SHA256_PATTERN.test(sha256)) issue(issues, "invalid_artifact_hash", `${path}.sha256`, `${path}.sha256 must be exactly 64 lower-case hexadecimal characters`);
  const identity = optionalArtifactReferenceText(input.identity, `${path}.identity`, issues);
  const reference = optionalArtifactReferenceText(aliased(input, ["reference", "ref", "artifactRef", "artifact_ref"], `${path}.reference`, issues), `${path}.reference`, issues);
  const byteValue = aliased<unknown>(input, ["byteLength", "byte_length", "sizeBytes", "size_bytes"], `${path}.byteLength`, issues);
  const byteLength = byteValue === undefined ? null : safeNumber(byteValue, `${path}.byteLength`, issues);
  const mediaType = optionalText(aliased(input, ["mediaType", "media_type"], `${path}.mediaType`, issues), `${path}.mediaType`, issues, 256);
  let provenance: string | JsonObject | null | undefined;
  if (input.provenance === null || input.provenance === undefined || typeof input.provenance === "string") {
    provenance = optionalText(input.provenance, `${path}.provenance`, issues, MAX_IDENTIFIER_LENGTH);
  } else {
    provenance = metadata(input.provenance, `${path}.provenance`, issues);
  }
  const normalizedMetadata = metadata(input.metadata, `${path}.metadata`, issues);
  if (artifactKey === undefined || artifactKind === undefined || sha256 === undefined || reference === undefined || byteLength === undefined || issues.some((entry) => entry.path.startsWith(path))) return undefined;
  return { artifactKey, artifactKind, sha256, reference, identity: identity ?? null, byteLength, mediaType: mediaType ?? null, provenance: provenance ?? null, metadata: normalizedMetadata };
}

function normalizeArtifacts(value: unknown, issues: ValidationIssue[]): ArtifactReference[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    issue(issues, "invalid_artifact", "assessment.artifactReferences", "artifactReferences must be an array");
    return [];
  }
  if (value.length > MAX_ARTIFACT_REFERENCES) issue(issues, "artifact_limit_exceeded", "assessment.artifactReferences", `artifactReferences exceeds ${MAX_ARTIFACT_REFERENCES}`);
  const result: ArtifactReference[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < value.length; index += 1) {
    const artifact = normalizeArtifact(value[index], index, issues);
    if (artifact === undefined) continue;
    const identity = `${artifact.artifactKey}\u0000${artifact.sha256}`;
    if (seen.has(identity)) issue(issues, "duplicate_artifact", `assessment.artifactReferences[${index}]`, "duplicate artifact reference");
    seen.add(identity);
    result.push(artifact);
  }
  return result.sort((a, b) => a.artifactKey.localeCompare(b.artifactKey) || a.artifactKind.localeCompare(b.artifactKind) || a.sha256.localeCompare(b.sha256) || (a.reference ?? "").localeCompare(b.reference ?? ""));
}

/**
 * Validate and normalize a producer/assessor submission.  Authority fields,
 * assessor identity, and technical run status are intentionally not part of
 * the accepted field set; they must come from a trusted adapter lookup.
 */
export function validateAssessment(input: AssessmentSubmissionInput): ValidationResult<AssessmentSubmission> {
  const issues: ValidationIssue[] = [];
  if (!isPlainObject(input)) {
    issue(issues, "invalid_object", "assessment", "assessment must be a plain object");
    return { ok: false, error: validationError(issues, "invalid_assessment", "invalid assessment"), issues };
  }
  rejectUnknownFields(input, ASSESSMENT_FIELDS, "assessment", issues);
  if (input.schemaVersion !== undefined && input.schemaVersion !== ASSESSMENT_SCHEMA_VERSION) issue(issues, "invalid_schema_version", "assessment.schemaVersion", `assessment.schemaVersion must be ${ASSESSMENT_SCHEMA_VERSION}`);
  const runId = requiredText(aliased(input, ["runId", "run_id"], "assessment.runId", issues), "assessment.runId", issues);
  const policyKey = optionalText(aliased(input, ["policyKey", "policy_key"], "assessment.policyKey", issues), "assessment.policyKey", issues);
  const policyVersion = optionalText(aliased(input, ["policyVersion", "policy_version"], "assessment.policyVersion", issues), "assessment.policyVersion", issues);
  const assessmentKind = enumValue(aliased<unknown>(input, ["assessmentKind", "assessment_kind", "kind"], "assessment.assessmentKind", issues), ASSESSMENT_KINDS, "assessment.assessmentKind", issues);
  const verdict = enumValue(input.verdict, ["passed", "failed", "inconclusive", "unknown"], "assessment.verdict", issues);
  const failureStage = enumValue(aliased<unknown>(input, ["failureStage", "failure_stage"], "assessment.failureStage", issues) ?? "none", FAILURE_STAGES, "assessment.failureStage", issues);
  const failureClass = enumValue(aliased<unknown>(input, ["failureClass", "failure_class"], "assessment.failureClass", issues) ?? "none", FAILURE_CLASSES, "assessment.failureClass", issues);
  const stopReason = enumValue(aliased<unknown>(input, ["stopReason", "stop_reason"], "assessment.stopReason", issues) ?? "completed", STOP_REASONS, "assessment.stopReason", issues);
  const startedAt = normalizedTimestamp(aliased(input, ["startedAt", "started_at"], "assessment.startedAt", issues), "assessment.startedAt", issues);
  const completedAt = normalizedTimestamp(aliased(input, ["completedAt", "completed_at"], "assessment.completedAt", issues), "assessment.completedAt", issues);
  if (startedAt !== undefined && completedAt !== undefined && startedAt !== null && completedAt !== null && Date.parse(completedAt) < Date.parse(startedAt)) issue(issues, "invalid_time_order", "assessment.completedAt", "completedAt cannot precede startedAt");
  const summaryValue = input.summary === undefined ? "" : input.summary;
  if (typeof summaryValue !== "string" || summaryValue.length > MAX_SUMMARY_LENGTH || CONTROL_PATTERN.test(summaryValue)) issue(issues, "invalid_summary", "assessment.summary", `summary must be a bounded text value of at most ${MAX_SUMMARY_LENGTH} characters`);
  const summary = typeof summaryValue === "string" ? summaryValue.trim() : "";
  if (sensitiveValue(summary)) issue(issues, "credential_like_content", "assessment.summary", "summary contains credential-like content");
  const normalizedMetadata = metadata(input.metadata, "assessment.metadata", issues);
  const declaredBudgetValue = aliased(input, ["declaredBudgets", "declared_budgets"], "assessment.declaredBudgets", issues);
  const normalizedBudgets = normalizeBudgets(declaredBudgetValue, issues);
  const usageValue = input.usage !== undefined ? input.usage : (input.usageObservations !== undefined ? input.usageObservations : input.usage_observations);
  const normalizedUsage = normalizeUsageList(usageValue, issues);
  const artifactsValue = aliased(input, ["artifactReferences", "artifact_references"], "assessment.artifactReferences", issues);
  const normalizedArtifacts = normalizeArtifacts(artifactsValue, issues);
  const requestKey = firstDefined(input.requestIdempotencyKey, input.request_idempotency_key);
  if (requestKey !== undefined) requiredText(requestKey, "assessment.requestIdempotencyKey", issues);
  const startedAtInvalid = (input.startedAt !== undefined || input.started_at !== undefined) && startedAt === undefined;
  const completedAtInvalid = (input.completedAt !== undefined || input.completed_at !== undefined) && completedAt === undefined;
  if (issues.length > 0 || runId === undefined || assessmentKind === undefined || verdict === undefined || failureStage === undefined || failureClass === undefined || stopReason === undefined || startedAtInvalid || completedAtInvalid) {
    return { ok: false, error: validationError(issues, "invalid_assessment", "invalid assessment"), issues };
  }
  return {
    ok: true,
    value: {
      schemaVersion: ASSESSMENT_SCHEMA_VERSION,
      runId,
      policyKey: policyKey ?? null,
      policyVersion: policyVersion ?? null,
      assessmentKind,
      verdict,
      failureStage,
      failureClass,
      stopReason,
      startedAt: startedAt ?? null,
      completedAt: completedAt ?? null,
      summary,
      metadata: normalizedMetadata,
      declaredBudgets: normalizedBudgets,
      usage: normalizedUsage,
      artifactReferences: normalizedArtifacts,
    },
    issues: [],
  };
}

export function normalizeAssessment(input: AssessmentSubmissionInput | AssessmentSubmission): AssessmentSubmission {
  return throwValidation(validateAssessment(input));
}

export const validateAssessmentSubmission = validateAssessment;
export const normalizeAssessmentSubmission = normalizeAssessment;

/** Normalize authority only at the trusted policy boundary, never from a submission. */
export function validateAssessorAuthority(input: AssessorAuthorityInput): ValidationResult<AssessorAuthority> {
  const issues: ValidationIssue[] = [];
  if (!isPlainObject(input)) {
    issue(issues, "invalid_object", "authority", "authority must be a plain object");
    return { ok: false, error: validationError(issues, "assessor_authority_invalid", "invalid assessor authority"), issues };
  }
  const allowed = new Set(["assessorType", "independence"]);
  rejectUnknownFields(input, allowed, "authority", issues);
  const assessorType = enumValue(input.assessorType, ASSESSOR_TYPES, "authority.assessorType", issues);
  const independence = enumValue(input.independence, ASSESSOR_INDEPENDENCE_VALUES, "authority.independence", issues);
  if (assessorType === "producer_self_check" && independence === "independent") issue(issues, "assessor_authority_invalid", "authority.independence", "a producer self-check cannot claim independent authority");
  if (issues.length > 0 || assessorType === undefined || independence === undefined) return { ok: false, error: validationError(issues, "assessor_authority_invalid", "invalid assessor authority"), issues };
  return { ok: true, value: { assessorType, independence }, issues: [] };
}

export function normalizeAssessorAuthority(input: AssessorAuthorityInput | AssessorAuthority): AssessorAuthority {
  return throwValidation(validateAssessorAuthority(input));
}
