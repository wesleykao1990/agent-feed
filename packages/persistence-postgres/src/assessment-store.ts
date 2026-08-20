import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import type { PoolClient, QueryResultRow } from "pg";
import * as AssessmentCore from "@agent-feed/assessment-core";
import { PersistenceError } from "./errors.ts";
import { canonicalJson, payloadHash } from "./hash.ts";
import type {
  AssessmentArtifactReference,
  AssessmentArtifactReferenceInput,
  AssessmentFailureClass,
  AssessmentFailureStage,
  AssessmentKind,
  AssessmentListOptions,
  AssessmentMetric,
  AssessmentProvenance,
  AssessmentStopReason,
  AssessmentVerdict,
  AssessorIndependence,
  DeclaredBudget,
  DeclaredBudgetInput,
  DeclaredBudgetState,
  JsonObject,
  PgPool,
  PgTransactionClient,
  RunAssessmentReceipt,
  SubmitAssessmentInput,
  TrustedAssessorRegistrationVersion,
  TrustedAssessorRegistrationVersionInput,
  TrustedAssessorVersionContext,
  UsageObservation,
  UsageObservationInput,
  UsageState,
  ValidationPolicyV1,
  ValidationPolicyVersion,
  ValidationPolicyVersionInput,
} from "./types.ts";

const ASSESSOR_TYPES = ["producer_self_check", "independent_agent", "human_reviewer", "validation_service"] as const;
const INDEPENDENCE = ["self", "independent", "unknown"] as const;
const KINDS = ["technical", "quality", "security", "compliance", "operational"] as const;
const VERDICTS = ["passed", "failed", "inconclusive", "unknown"] as const;
const FAILURE_STAGES = ["none", "setup", "execution", "collection", "validation", "teardown", "unknown"] as const;
const FAILURE_CLASSES = [
  "none", "configuration", "authentication", "authorization", "dependency", "timeout", "budget",
  "rate_limit", "provider", "network", "contract", "data_quality", "security", "cancelled", "unknown",
] as const;
const STOP_REASONS = [
  "completed", "policy_failed", "budget_exhausted", "timeout", "cancelled", "assessor_error",
  "dependency_unavailable", "manual_stop", "unknown",
] as const;
const METRICS = ["wall_time_ms", "input_tokens", "output_tokens", "cost_microunits", "tool_calls", "network_requests", "artifact_bytes"] as const;
const PROVENANCE = ["provider_reported", "executor_measured", "assessor_observed", "operator_entered", "derived", "unknown"] as const;
const BUDGET_STATES = ["declared", "unknown", "not_applicable"] as const;
const USAGE_STATES = ["observed", "unknown", "not_applicable"] as const;
const SUBMISSION_FIELDS = new Set([
  "schemaVersion", "runId", "run_id", "tenant_id", "policy_version_id", "policyKey", "policy_key", "policyVersion", "policy_version",
  "requestIdempotencyKey", "request_idempotency_key", "assessmentKind", "assessment_kind", "kind", "verdict",
  "failureStage", "failure_stage", "failureClass", "failure_class", "stopReason", "stop_reason", "startedAt", "started_at",
  "completedAt", "completed_at", "summary", "metadata", "reassessment_of", "declaredBudgets", "declared_budgets",
  "usage", "usageObservations", "usage_observations", "artifactReferences", "artifact_references",
]);

type CoreModule = Record<string, unknown>;
const coreModule = AssessmentCore as unknown as CoreModule;

interface DbPolicyRow extends QueryResultRow {
  id: string;
  tenant_id: string;
  policy_key: string;
  version: number | string;
  policy_json: JsonObject;
  policy_canonical_json: string;
  policy_hash: string;
  metadata: JsonObject;
  created_at: Date | string;
}

interface DbRegistrationRow extends QueryResultRow {
  id: string;
  tenant_id: string;
  assessor_id: string;
  version: number | string;
  assessor_type: TrustedAssessorRegistrationVersion["assessor_type"];
  independence: AssessorIndependence;
  trusted_key_digest: string | null;
  subject_digest: string | null;
  status: TrustedAssessorRegistrationVersion["status"];
  supersedes_id: string | null;
  metadata: JsonObject;
  created_at: Date | string;
}

interface DbAssessmentRow extends QueryResultRow {
  id: string;
  tenant_id: string;
  run_id: string;
  wire_run_id: string;
  run_status: RunAssessmentReceipt["run_status"];
  run_completed_at: Date | string | null;
  policy_version_id: string;
  assessor_registration_version_id: string;
  assessor_id: string;
  assessor_type: RunAssessmentReceipt["assessor_type"];
  assessor_independence: AssessorIndependence;
  request_idempotency_key: string;
  request_payload_hash: string;
  assessment_kind: AssessmentKind;
  verdict: AssessmentVerdict;
  failure_stage: AssessmentFailureStage;
  failure_class: AssessmentFailureClass;
  stop_reason: AssessmentStopReason;
  started_at: Date | string | null;
  completed_at: Date | string | null;
  summary: string;
  metadata: JsonObject;
  reassessment_of: string | null;
  created_at: Date | string;
}

interface DbBudgetRow extends QueryResultRow {
  id: string;
  tenant_id: string;
  assessment_id: string;
  budget_key: string;
  state: DeclaredBudgetState;
  limit_value: string | number | null;
  unit: string;
  metadata: JsonObject;
  created_at: Date | string;
}

interface DbUsageRow extends QueryResultRow {
  id: string;
  tenant_id: string;
  assessment_id: string;
  usage_key: string;
  metric: AssessmentMetric;
  state: UsageState;
  value: string | number | null;
  unit: string;
  provenance: AssessmentProvenance;
  provenance_details: JsonObject;
  observed_at: Date | string | null;
  metadata: JsonObject;
  created_at: Date | string;
}

interface DbArtifactRow extends QueryResultRow {
  id: string;
  tenant_id: string;
  assessment_id: string;
  artifact_key: string;
  artifact_kind: string;
  artifact_hash: string;
  identity: string | null;
  reference: string | null;
  provenance: JsonObject;
  media_type: string | null;
  size_bytes: string | number | null;
  metadata: JsonObject;
  created_at: Date | string;
}

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function object(value: unknown, field: string): JsonObject {
  if (value === undefined || value === null) return {};
  if (!isObject(value)) throw new PersistenceError("invalid_input", `${field} must be an object`, { field });
  const encoded = JSON.stringify(value);
  if (encoded === undefined || Buffer.byteLength(encoded, "utf8") > 65_536) {
    throw new PersistenceError("invalid_input", `${field} is too large`, { field });
  }
  return value;
}

function stringInput(value: unknown, field: string, min = 1, max = 2_048): string {
  if (typeof value !== "string" || value.length < min || value.length > max) {
    throw new PersistenceError("invalid_input", `${field} must be between ${min} and ${max} characters`, { field });
  }
  return value;
}

function tenant(value: string | undefined): string {
  return stringInput(value ?? "default", "tenant_id", 1, 256);
}

function asInt(value: number | string, field: string): number {
  const result = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(result)) throw new PersistenceError("storage_error", `database returned an invalid ${field}`);
  return result;
}

function iso(value: Date | string | null): string | null {
  if (value === null) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new PersistenceError("storage_error", "database returned an invalid timestamp");
  return date.toISOString();
}

function timestamp(value: string | null | undefined, field: string): Date | null {
  if (value === undefined || value === null) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new PersistenceError("invalid_input", `${field} must be an ISO date-time`, { field });
  return date;
}

function enumValue<T extends readonly string[]>(value: unknown, allowed: T, field: string): T[number] {
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    throw new PersistenceError("assessment_validation_failed", `${field} is not a supported assessment value`, { field, value });
  }
  return value as T[number];
}

const ARTIFACT_SENSITIVE_KEY = /(?:authorization|credential|password|secret|token|private\s*key|api\s*key|access\s*key|signed\s*url|signature|inline|blob|base64|payload|content|raw|body)/iu;
const ARTIFACT_CREDENTIAL_VALUE = [
  /\b(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/iu,
  /\bAWS4-HMAC-SHA256\b/iu,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/u,
  /\b(?:gh[pousr]|github_pat)_[A-Za-z0-9_]{20,}\b/u,
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{16,}\b/u,
  /\bAIza[0-9A-Za-z_-]{20,}\b/u,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/u,
  /\b(?:pk|rk|sk)_(?:live|test)_[0-9A-Za-z]{16,}\b/u,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/u,
] as const;

function unsafeArtifactText(value: string): boolean {
  return /[?#]/u.test(value)
    || /^\s*(?:data|blob|inline|base64|content):/iu.test(value)
    || /^(?:[A-Za-z0-9+/]{32,}={0,2})$/u.test(value.trim())
    || /\b[a-z][a-z0-9+.-]*:\/\/[^\s\/?#@]+@/iu.test(value)
    || /(?:signed|presign|presigned)[\s_-]*url/iu.test(value)
    || ARTIFACT_CREDENTIAL_VALUE.some((pattern) => pattern.test(value));
}

function assertArtifactSafety(value: unknown, field: string): void {
  if (value === null || value === undefined) return;
  if (typeof value === "string") {
    if (unsafeArtifactText(value)) {
      throw new PersistenceError("assessment_validation_failed", `${field} contains forbidden artifact content or credential material`, { field });
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertArtifactSafety(entry, `${field}[${index}]`));
    return;
  }
  if (isObject(value)) {
    for (const [key, entry] of Object.entries(value)) {
      if (ARTIFACT_SENSITIVE_KEY.test(key)) {
        throw new PersistenceError("assessment_validation_failed", `${field}.${key} is not permitted in artifact provenance or metadata`, { field: `${field}.${key}` });
      }
      assertArtifactSafety(entry, `${field}.${key}`);
    }
  }
}

function safeInteger(value: number | string | null | undefined, field: string, required = false): string | null {
  if (value === undefined || value === null || value === "") {
    if (required) throw new PersistenceError("assessment_validation_failed", `${field} is required`, { field });
    return null;
  }
  if (typeof value === "number" && !Number.isSafeInteger(value)) {
    throw new PersistenceError("assessment_validation_failed", `${field} must be a non-negative safe integer`, { field });
  }
  const text = typeof value === "number" ? String(value) : value;
  if (typeof text !== "string" || !/^(?:0|[1-9][0-9]*)$/u.test(text)) {
    throw new PersistenceError("assessment_validation_failed", `${field} must be a non-negative safe integer`, { field });
  }
  const numberValue = Number(text);
  if (!Number.isSafeInteger(numberValue) || numberValue < 0 || numberValue > Number.MAX_SAFE_INTEGER) {
    throw new PersistenceError("assessment_validation_failed", `${field} must be a non-negative safe value`, { field });
  }
  return text;
}

function digest(value: unknown, field: string, required = false): string | null {
  if (value === undefined || value === null || value === "") {
    if (required) throw new PersistenceError("invalid_input", `${field} is required`, { field });
    return null;
  }
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value)) {
    throw new PersistenceError("invalid_input", `${field} must be a lowercase SHA-256 digest`, { field });
  }
  return value;
}

function noArtifactPayload(value: unknown, field: string): void {
  assertArtifactSafety(value ?? {}, field);
}

function artifactReference(value: string | null, field: string): string | null {
  if (value === null) return null;
  stringInput(value, field, 1, 2_048);
  if (unsafeArtifactText(value)) {
    throw new PersistenceError("assessment_validation_failed", `${field} must be a bounded identity/provenance reference without query, fragment, credentials, or content`, { field });
  }
  return value;
}

function canonicalPolicyFallback(value: JsonObject): { policy: ValidationPolicyV1; hash: string; canonical: string } {
  const schemaVersion = value.schemaVersion ?? value.schema_version;
  const policyKey = value.policyKey ?? value.policy_key ?? null;
  const policyVersion = value.policyVersion ?? value.policy_version ?? null;
  const kinds = value.requiredAssessmentKinds ?? value.required_assessment_kinds ?? value.requiredKinds ?? value.required_kinds;
  const minimum = value.minimumIndependence ?? value.minimum_independence;
  const budgetRequirement = value.declaredBudgetRequirement ?? value.declared_budget_requirement ?? "optional";
  const metadata = object(value.metadata, "policy.metadata");
  if (schemaVersion !== "agent-feed.validation-policy.v1") {
    throw new PersistenceError("assessment_validation_failed", "policy schema_version must be agent-feed.validation-policy.v1");
  }
  if (!Array.isArray(kinds)) {
    throw new PersistenceError("assessment_validation_failed", "policy required_kinds must be an array");
  }
  const normalizedKinds = kinds.map((kind) => enumValue(kind, KINDS, "policy.required_kinds"));
  const normalizedMinimum = enumValue(minimum, ["self", "independent"] as const, "policy.minimumIndependence");
  const normalizedBudget = enumValue(budgetRequirement, ["required", "optional", "not_applicable"] as const, "policy.declaredBudgetRequirement");
  const policy = {
    schemaVersion: "agent-feed.validation-policy.v1" as const,
    policyKey: typeof policyKey === "string" ? policyKey : null,
    policyVersion: typeof policyVersion === "string" ? policyVersion : null,
    requiredAssessmentKinds: normalizedKinds,
    minimumIndependence: normalizedMinimum,
    declaredBudgetRequirement: normalizedBudget,
    metadata,
  } satisfies ValidationPolicyV1;
  const canonical = canonicalJson(policy as unknown as JsonObject);
  return { policy, hash: payloadHash(policy), canonical };
}

function corePolicy(value: JsonObject): { policy: ValidationPolicyV1; hash: string; canonical: string } {
  const normalize = coreModule.normalizeValidationPolicy ?? coreModule.normalizePolicy;
  if (typeof normalize === "function") {
    try {
      const result = (normalize as (input: unknown) => unknown)(value);
      if (isObject(result)) {
        const normalized = canonicalPolicyFallback(result);
        const hashFunction = coreModule.hashValidationPolicy ?? coreModule.hashPolicy;
        const canonicalFunction = coreModule.canonicalValidationPolicy ?? coreModule.canonicalPolicy;
        const canonical = typeof canonicalFunction === "function"
          ? (canonicalFunction as (input: unknown) => unknown)(result)
          : normalized.canonical;
        if (typeof hashFunction === "function") {
          const hash = (hashFunction as (input: unknown) => unknown)(result);
          if (typeof hash === "string" && /^[0-9a-f]{64}$/u.test(hash) && typeof canonical === "string") return { policy: normalized.policy, hash, canonical };
        }
        return normalized;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new PersistenceError("assessment_validation_failed", `assessment-core rejected validation policy: ${message}`, { source: "@agent-feed/assessment-core" });
    }
  }
  return canonicalPolicyFallback(value);
}

function normalizePolicy(input: ValidationPolicyVersionInput): { tenantId: string; policyKey: string; version: number; policy: ValidationPolicyV1; hash: string; canonical: string; metadata: JsonObject } {
  const raw = input as unknown as Record<string, unknown>;
  const policyValue = raw.policy ?? raw.policy_json;
  if (!isObject(policyValue)) throw new PersistenceError("assessment_validation_failed", "policy is required");
  const policyKey = stringInput(input.policy_key, "policy_key", 1, 512).trim();
  if (policyKey.length === 0) throw new PersistenceError("invalid_input", "policy_key must not be blank");
  const version = input.version ?? 1;
  if (!Number.isSafeInteger(version) || version < 1) throw new PersistenceError("invalid_input", "policy version must be a positive integer");
  const policy = corePolicy({ ...policyValue, policyKey, policyVersion: String(version) });
  return {
    tenantId: tenant(input.tenant_id),
    policyKey,
    version,
    policy: policy.policy,
    hash: policy.hash,
    canonical: policy.canonical,
    metadata: object(input.metadata, "metadata"),
  };
}

function normalizeRegistration(input: TrustedAssessorRegistrationVersionInput): {
  tenantId: string; assessorId: string; version: number; assessorType: TrustedAssessorRegistrationVersion["assessor_type"];
  independence: AssessorIndependence; trustedKeyDigest: string | null; subjectDigest: string | null;
  status: TrustedAssessorRegistrationVersion["status"]; supersedesId: string | null; metadata: JsonObject;
} {
  const raw = input as unknown as Record<string, unknown>;
  const assessorId = stringInput(raw.assessor_id ?? raw.assessor_key, "assessor_id", 1, 512);
  const assessorType = enumValue(input.assessor_type, ASSESSOR_TYPES, "assessor_type");
  const independence = assessorType === "producer_self_check"
    ? "self"
    : enumValue(input.independence ?? "unknown", INDEPENDENCE, "independence");
  const trustedKeyDigest = digest(input.trusted_key_digest, "trusted_key_digest");
  const subjectDigest = digest(input.subject_digest, "subject_digest");
  if (trustedKeyDigest === null && subjectDigest === null) {
    throw new PersistenceError("invalid_input", "trusted_key_digest or subject_digest is required");
  }
  const version = input.version ?? 1;
  if (!Number.isSafeInteger(version) || version < 1) throw new PersistenceError("invalid_input", "assessor version must be a positive integer");
  return {
    tenantId: tenant(input.tenant_id),
    assessorId,
    version,
    assessorType,
    independence,
    trustedKeyDigest,
    subjectDigest,
    status: input.status ?? "active",
    supersedesId: input.supersedes_id ?? null,
    metadata: object(input.metadata, "metadata"),
  };
}

function normalizeBudgets(input: readonly DeclaredBudgetInput[] | undefined): Array<{
  budgetKey: string; state: DeclaredBudgetState; limitValue: string | null; unit: string; metadata: JsonObject;
}> {
  const seen = new Set<string>();
  return (input ?? []).map((value) => {
    const raw = value as unknown as Record<string, unknown>;
    const budgetKey = stringInput(raw.budget_key ?? raw.budgetKey, "declared_budgets.budget_key", 1, 256);
    if (seen.has(budgetKey)) throw new PersistenceError("assessment_validation_failed", "declared budget keys must be unique", { budget_key: budgetKey });
    seen.add(budgetKey);
    const rawLimit = raw.limit ?? raw.limitValue ?? raw.limit_value;
    const state = enumValue(raw.state ?? raw.budgetState ?? raw.budget_state ?? (rawLimit === undefined ? "unknown" : "declared"), BUDGET_STATES, "declared_budgets.state");
    const limitValue = state === "declared" ? safeInteger(rawLimit as number | string | null | undefined, "declared_budgets.limit_value", true) : safeInteger(rawLimit as number | string | null | undefined, "declared_budgets.limit_value");
    if (state !== "declared" && limitValue !== null) throw new PersistenceError("assessment_validation_failed", "unknown/not_applicable budgets require NULL limit_value");
    return { budgetKey, state, limitValue, unit: stringInput(value.unit ?? "", "declared_budgets.unit", 0, 128), metadata: object(value.metadata, "declared_budgets.metadata") };
  });
}

function normalizeUsage(input: readonly UsageObservationInput[] | undefined): Array<{
  usageKey: string; metric: AssessmentMetric; state: UsageState; value: string | null; unit: string;
  provenance: AssessmentProvenance; provenanceDetails: JsonObject; observedAt: Date | null; metadata: JsonObject;
}> {
  const seen = new Set<string>();
  return (input ?? []).map((value) => {
    const raw = value as unknown as Record<string, unknown>;
    const metric = enumValue(value.metric, METRICS, "usage_observations.metric");
    // assessment-core intentionally makes usageKey optional because the
    // metric is already unique in a normalized request.  Persist a stable
    // metric-derived key when the caller omits it rather than rejecting a
    // valid core assessment or inventing a random child identity.
    const usageKey = stringInput(raw.usage_key ?? raw.usageKey ?? metric, "usage_observations.usage_key", 1, 256);
    if (seen.has(usageKey)) throw new PersistenceError("assessment_validation_failed", "usage keys must be unique", { usage_key: usageKey });
    seen.add(usageKey);
    const rawValue = raw.value as number | string | null | undefined;
    const state = enumValue(raw.state ?? raw.telemetryState ?? raw.usage_state ?? (rawValue === undefined || rawValue === null ? "unknown" : "observed"), USAGE_STATES, "usage_observations.state");
    const provenance = enumValue(raw.provenance ?? raw.usageProvenance ?? raw.provenance_state ?? "unknown", PROVENANCE, "usage_observations.provenance");
    const normalizedValue = state === "observed" ? safeInteger(rawValue, "usage_observations.value", true) : safeInteger(rawValue, "usage_observations.value");
    if (state === "observed" && provenance === "unknown") throw new PersistenceError("assessment_validation_failed", "observed usage requires non-unknown provenance");
    if (state !== "observed" && normalizedValue !== null) throw new PersistenceError("assessment_validation_failed", "unknown/not_applicable usage requires NULL value");
    return {
      usageKey,
      metric,
      state,
      value: normalizedValue,
      unit: stringInput(value.unit ?? "", "usage_observations.unit", 0, 128),
      provenance,
      provenanceDetails: object(raw.provenanceDetails ?? raw.provenance_details, "usage_observations.provenance_details"),
      observedAt: timestamp((raw.observed_at ?? raw.observedAt) as string | null | undefined, "usage_observations.observed_at"),
      metadata: object(value.metadata, "usage_observations.metadata"),
    };
  });
}

function normalizeArtifacts(input: readonly AssessmentArtifactReferenceInput[] | undefined): Array<{
  artifactKey: string; artifactKind: string; artifactHash: string; identity: string | null; reference: string | null;
  provenance: string | JsonObject | null; mediaType: string | null; sizeBytes: string | null; metadata: JsonObject;
}> {
  const seen = new Set<string>();
  return (input ?? []).map((value) => {
    const raw = value as unknown as Record<string, unknown>;
    const artifactKey = stringInput(raw.artifact_key ?? raw.artifactKey, "artifact_references.artifact_key", 1, 256);
    if (seen.has(artifactKey)) throw new PersistenceError("assessment_validation_failed", "artifact keys must be unique", { artifact_key: artifactKey });
    seen.add(artifactKey);
    const artifactKind = stringInput(raw.artifact_kind ?? raw.artifactKind ?? raw.kind, "artifact_references.artifact_kind", 1, 256);
    const artifactHash = digest(raw.artifact_hash ?? raw.sha256, "artifact_references.artifact_hash", true);
    if (artifactHash === null) throw new PersistenceError("assessment_validation_failed", "artifact hash is required");
    const provenanceValue = raw.provenance;
    const provenance = provenanceValue === null || provenanceValue === undefined || typeof provenanceValue === "string"
      ? provenanceValue ?? null
      : object(provenanceValue, "artifact_references.provenance");
    const metadata = object(value.metadata, "artifact_references.metadata");
    noArtifactPayload(provenance, "artifact_references.provenance");
    noArtifactPayload(metadata, "artifact_references.metadata");
    const identity = artifactReference((raw.identity as string | null | undefined) ?? null, "artifact_references.identity");
    const reference = artifactReference((raw.reference as string | null | undefined) ?? null, "artifact_references.reference");
    const sizeBytes = safeInteger((raw.size_bytes ?? raw.sizeBytes ?? raw.byte_length ?? raw.byteLength) as number | string | null | undefined, "artifact_references.size_bytes");
    return {
      artifactKey,
      artifactKind,
      artifactHash,
      identity,
      reference,
      provenance,
      mediaType: raw.media_type === null || raw.media_type === undefined
        ? (raw.mediaType === null || raw.mediaType === undefined ? null : stringInput(raw.mediaType, "artifact_references.media_type", 1, 256))
        : stringInput(raw.media_type, "artifact_references.media_type", 1, 256),
      sizeBytes,
      metadata,
    };
  });
}

function assertSubmissionHasNoAuthorityFields(input: SubmitAssessmentInput): void {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new PersistenceError("invalid_input", "assessment submission must be an object");
  }
  const keys = Object.keys(input as unknown as Record<string, unknown>);
  const unknown = keys.find((key) => !SUBMISSION_FIELDS.has(key));
  if (unknown !== undefined) {
    throw new PersistenceError("assessment_validation_failed", `assessment submission contains an unsupported field: ${unknown}`, { field: unknown });
  }
  const forbidden = keys.find((key) => {
    const normalized = key.toLowerCase().replace(/[^a-z0-9]/gu, "");
    return normalized.startsWith("assessor")
      || normalized === "independence"
      || normalized.startsWith("trustedkey")
      || normalized === "subjectdigest"
      || normalized === "runstatus"
      || normalized === "runcompletedat"
      || normalized === "technicalstatus"
      || normalized === "technicalrunstatus"
      || normalized === "technicalcompletion";
  });
  if (forbidden !== undefined) {
    throw new PersistenceError("assessment_validation_failed", `assessment submission cannot provide trusted authority or technical status: ${forbidden}`);
  }
}

function policyRequiresBudget(policy: ValidationPolicyV1): boolean {
  return policy.declaredBudgetRequirement === "required";
}

function policyAllows(policy: ValidationPolicyV1, kind: AssessmentKind, independence: AssessorIndependence): void {
  if (policy.requiredAssessmentKinds.length > 0 && !policy.requiredAssessmentKinds.includes(kind)) throw new PersistenceError("assessment_validation_failed", "assessment kind is not required by the validation policy", { assessment_kind: kind });
  if (independence === "unknown") {
    throw new PersistenceError("assessor_not_independent", "trusted assessor independence is unknown");
  }
  if (policy.minimumIndependence === "independent" && independence !== "independent") {
    throw new PersistenceError("assessor_not_independent", "validation policy requires an independent assessor");
  }
  if (policy.minimumIndependence === "self" && independence !== "self" && independence !== "independent") {
    throw new PersistenceError("assessor_not_independent", "validation policy requires a self or independent assessor");
  }
}

interface NormalizedCoreAssessment {
  runId: string;
  policyKey: string | null;
  policyVersion: string | null;
  assessmentKind: AssessmentKind;
  verdict: AssessmentVerdict;
  failureStage: AssessmentFailureStage;
  failureClass: AssessmentFailureClass;
  stopReason: AssessmentStopReason;
  startedAt: string | null;
  completedAt: string | null;
  summary: string;
  metadata: JsonObject;
  declaredBudgets: readonly JsonObject[];
  usage: readonly JsonObject[];
  artifactReferences: readonly JsonObject[];
}

function normalizeCoreAssessment(input: SubmitAssessmentInput): { value: NormalizedCoreAssessment; hash: string } {
  const raw = input as unknown as Record<string, unknown>;
  const normalize = coreModule.normalizeAssessment ?? coreModule.normalizeAssessmentSubmission;
  if (typeof normalize !== "function") throw new PersistenceError("assessment_validation_failed", "assessment-core normalizeAssessment is unavailable");
  const candidate = {
    schemaVersion: raw.schemaVersion,
    runId: raw.runId,
    run_id: raw.run_id,
    policyKey: raw.policyKey,
    policy_key: raw.policy_key,
    policyVersion: raw.policyVersion,
    policy_version: raw.policy_version,
    assessmentKind: raw.assessmentKind,
    assessment_kind: raw.assessment_kind,
    kind: raw.kind,
    verdict: raw.verdict,
    failureStage: raw.failureStage,
    failure_stage: raw.failure_stage,
    failureClass: raw.failureClass,
    failure_class: raw.failure_class,
    stopReason: raw.stopReason,
    stop_reason: raw.stop_reason,
    startedAt: raw.startedAt,
    started_at: raw.started_at,
    completedAt: raw.completedAt,
    completed_at: raw.completed_at,
    summary: raw.summary,
    metadata: raw.metadata,
    declaredBudgets: raw.declaredBudgets,
    declared_budgets: raw.declared_budgets,
    usage: raw.usage,
    usageObservations: raw.usageObservations,
    usage_observations: raw.usage_observations,
    artifactReferences: raw.artifactReferences,
    artifact_references: raw.artifact_references,
    requestIdempotencyKey: raw.requestIdempotencyKey,
    request_idempotency_key: raw.request_idempotency_key,
  };
  try {
    const value = (normalize as (value: unknown) => unknown)(candidate);
    if (!isObject(value)) throw new Error("normalizeAssessment returned a non-object");
    const hashFunction = coreModule.hashAssessmentRequest ?? coreModule.assessmentRequestHash ?? coreModule.hashRequest;
    const hash = typeof hashFunction === "function"
      ? (hashFunction as (value: unknown) => unknown)(value)
      : payloadHash(value);
    if (typeof hash !== "string" || !/^[0-9a-f]{64}$/u.test(hash)) throw new Error("normalizeAssessment returned an invalid hash");
    const result = value as unknown as NormalizedCoreAssessment;
    if (!Array.isArray(result.declaredBudgets) || !Array.isArray(result.usage) || !Array.isArray(result.artifactReferences)) throw new Error("normalizeAssessment returned invalid child collections");
    return { value: result, hash };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new PersistenceError("assessment_validation_failed", `assessment-core rejected assessment: ${message}`, { source: "@agent-feed/assessment-core" });
  }
}

function aliasedScalar(raw: Record<string, unknown>, names: readonly string[], field: string): unknown {
  const present = names.filter((name) => raw[name] !== undefined).map((name) => raw[name]);
  if (present.length > 1 && present.slice(1).some((value) => !Object.is(value, present[0]))) {
    throw new PersistenceError("assessment_validation_failed", `${field} has conflicting aliases`, { field });
  }
  return present[0];
}

function sameJson(a: JsonObject, b: JsonObject): boolean {
  return canonicalJson(a) === canonicalJson(b);
}

function mapError(error: unknown): PersistenceError {
  if (error instanceof PersistenceError) return error;
  const source = error as { code?: unknown; constraint?: unknown; message?: unknown };
  const code = typeof source?.code === "string" ? source.code : "";
  const constraint = typeof source?.constraint === "string" ? source.constraint : "";
  const message = typeof source?.message === "string" ? source.message : "database operation failed";
  if (code === "23505") {
    if (constraint.includes("policy_key")) return new PersistenceError("policy_version_conflict", "validation policy version already exists", { constraint });
    if (constraint.includes("assessor") && constraint.includes("version")) return new PersistenceError("assessor_registration_conflict", "trusted assessor registration version already exists", { constraint });
    if (constraint.includes("request_idempotency")) return new PersistenceError("assessment_conflict", "assessment idempotency key already exists", { constraint });
    return new PersistenceError("assessment_conflict", "job-proof uniqueness constraint rejected the request", { constraint });
  }
  if (code === "23503") return new PersistenceError("assessment_not_found", "assessment relation does not exist in the requested tenant", { constraint });
  if (code === "23514" || code === "22P02") return new PersistenceError("assessment_validation_failed", message, { constraint });
  if (/append-only|immutable|does not match|requires an independent|not required by/u.test(message)) {
    return new PersistenceError("assessment_validation_failed", message, { constraint });
  }
  return new PersistenceError("storage_error", "database operation failed", { constraint });
}

function mapPolicy(row: DbPolicyRow): ValidationPolicyVersion {
  const policy = row.policy_json as ValidationPolicyV1;
  return { id: row.id, tenant_id: row.tenant_id, policy_key: row.policy_key, version: asInt(row.version, "policy version"), policy, policy_json: policy, policy_hash: row.policy_hash, metadata: object(row.metadata, "policy metadata"), created_at: iso(row.created_at) ?? "" };
}

function mapRegistration(row: DbRegistrationRow): TrustedAssessorRegistrationVersion {
  return { id: row.id, tenant_id: row.tenant_id, assessor_id: row.assessor_id, assessor_key: row.assessor_id, version: asInt(row.version, "assessor version"), assessor_type: row.assessor_type, trusted_key_digest: row.trusted_key_digest, subject_digest: row.subject_digest, independence: row.independence, status: row.status, supersedes_id: row.supersedes_id, metadata: object(row.metadata, "assessor metadata"), created_at: iso(row.created_at) ?? "" };
}

function mapBudget(row: DbBudgetRow): DeclaredBudget {
  const state = row.state;
  return { id: row.id, tenant_id: row.tenant_id, assessment_id: row.assessment_id, budget_key: row.budget_key, state, budget_state: state, limit_value: row.limit_value === null ? null : String(row.limit_value), unit: row.unit, metadata: object(row.metadata, "budget metadata"), created_at: iso(row.created_at) ?? "" };
}

function mapUsage(row: DbUsageRow): UsageObservation {
  return { id: row.id, tenant_id: row.tenant_id, assessment_id: row.assessment_id, usage_key: row.usage_key, metric: row.metric, state: row.state, usage_state: row.state, value: row.value === null ? null : String(row.value), unit: row.unit, provenance: row.provenance, provenance_state: row.provenance, provenance_details: object(row.provenance_details, "usage provenance details"), observed_at: iso(row.observed_at), metadata: object(row.metadata, "usage metadata"), created_at: iso(row.created_at) ?? "" };
}

function mapArtifact(row: DbArtifactRow): AssessmentArtifactReference {
  return { id: row.id, tenant_id: row.tenant_id, assessment_id: row.assessment_id, artifact_key: row.artifact_key, artifact_kind: row.artifact_kind, artifact_hash: row.artifact_hash, sha256: row.artifact_hash, hash_algorithm: "sha256", identity: row.identity, reference: row.reference, provenance: row.provenance, media_type: row.media_type, size_bytes: row.size_bytes === null ? null : String(row.size_bytes), metadata: object(row.metadata, "artifact metadata"), created_at: iso(row.created_at) ?? "" };
}

export class PostgresAssessmentRepository {
  readonly pool: PgPool;

  constructor(pool: PgPool) {
    this.pool = pool;
  }

  async createValidationPolicyVersion(input: ValidationPolicyVersionInput): Promise<ValidationPolicyVersion> {
    const normalized = normalizePolicy(input);
    return this.withTransaction(async (client) => {
      await client.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [`m8:policy:${normalized.tenantId}:${normalized.policyKey}:${normalized.version}`]);
      const existing = await this.query<DbPolicyRow>(client, `select id, tenant_id, policy_key, version, policy_json, policy_canonical_json, policy_hash, metadata, created_at from agent_feed.validation_policy_versions where tenant_id = $1 and policy_key = $2 and version = $3 for update`, [normalized.tenantId, normalized.policyKey, normalized.version]);
      if (existing[0]) {
        if (existing[0].policy_hash !== normalized.hash
          || existing[0].policy_canonical_json !== normalized.canonical
          || !sameJson(existing[0].metadata, normalized.metadata)) {
          throw new PersistenceError("policy_version_conflict", "validation policy version is immutable and differs from the existing row");
        }
        return mapPolicy(existing[0]);
      }
      const rows = await this.query<DbPolicyRow>(client, `insert into agent_feed.validation_policy_versions (tenant_id, policy_key, version, policy_json, policy_canonical_json, policy_hash, metadata) values ($1, $2, $3, $4::jsonb, $5, $6, $7::jsonb) returning id, tenant_id, policy_key, version, policy_json, policy_canonical_json, policy_hash, metadata, created_at`, [normalized.tenantId, normalized.policyKey, normalized.version, normalized.canonical, normalized.canonical, normalized.hash, JSON.stringify(normalized.metadata)]);
      const row = rows[0];
      if (!row) throw new PersistenceError("storage_error", "database returned no validation policy row");
      return mapPolicy(row);
    });
  }

  async create_validation_policy_version(input: ValidationPolicyVersionInput): Promise<ValidationPolicyVersion> {
    return this.createValidationPolicyVersion(input);
  }

  async registerTrustedAssessorVersion(input: TrustedAssessorRegistrationVersionInput): Promise<TrustedAssessorRegistrationVersion> {
    const normalized = normalizeRegistration(input);
    return this.withTransaction(async (client) => {
      await client.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [`m8:assessor:${normalized.tenantId}:${normalized.assessorId}:${normalized.version}`]);
      const existing = await this.query<DbRegistrationRow>(client, `select id, tenant_id, assessor_id, version, assessor_type, independence, trusted_key_digest, subject_digest, status, supersedes_id, metadata, created_at from agent_feed.trusted_assessor_registration_versions where tenant_id = $1 and assessor_id = $2 and version = $3 for update`, [normalized.tenantId, normalized.assessorId, normalized.version]);
      if (existing[0]) {
        if (existing[0].assessor_type !== normalized.assessorType
          || existing[0].independence !== normalized.independence
          || existing[0].trusted_key_digest !== normalized.trustedKeyDigest
          || existing[0].subject_digest !== normalized.subjectDigest
          || existing[0].status !== normalized.status
          || existing[0].supersedes_id !== normalized.supersedesId
          || !sameJson(existing[0].metadata, normalized.metadata)) {
          throw new PersistenceError("assessor_registration_conflict", "trusted assessor registration version is immutable and differs from the existing row");
        }
        return mapRegistration(existing[0]);
      }
      const rows = await this.query<DbRegistrationRow>(client, `insert into agent_feed.trusted_assessor_registration_versions (tenant_id, assessor_id, version, assessor_type, independence, trusted_key_digest, subject_digest, status, supersedes_id, metadata) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb) returning id, tenant_id, assessor_id, version, assessor_type, independence, trusted_key_digest, subject_digest, status, supersedes_id, metadata, created_at`, [normalized.tenantId, normalized.assessorId, normalized.version, normalized.assessorType, normalized.independence, normalized.trustedKeyDigest, normalized.subjectDigest, normalized.status, normalized.supersedesId, JSON.stringify(normalized.metadata)]);
      const row = rows[0];
      if (!row) throw new PersistenceError("storage_error", "database returned no trusted assessor row");
      return mapRegistration(row);
    });
  }

  async register_trusted_assessor_version(input: TrustedAssessorRegistrationVersionInput): Promise<TrustedAssessorRegistrationVersion> {
    return this.registerTrustedAssessorVersion(input);
  }

  async getValidationPolicyVersion(tenantId: string, id: string): Promise<ValidationPolicyVersion | null> {
    const rows = await this.query<DbPolicyRow>(this.pool, `select id, tenant_id, policy_key, version, policy_json, policy_canonical_json, policy_hash, metadata, created_at from agent_feed.validation_policy_versions where tenant_id = $1 and id = $2`, [tenant(tenantId), id]);
    return rows[0] ? mapPolicy(rows[0]) : null;
  }

  async get_validation_policy_version(tenantId: string, id: string): Promise<ValidationPolicyVersion | null> {
    return this.getValidationPolicyVersion(tenantId, id);
  }

  async getTrustedAssessorVersion(tenantId: string, id: string): Promise<TrustedAssessorRegistrationVersion | null> {
    const rows = await this.query<DbRegistrationRow>(this.pool, `select id, tenant_id, assessor_id, version, assessor_type, independence, trusted_key_digest, subject_digest, status, supersedes_id, metadata, created_at from agent_feed.trusted_assessor_registration_versions where tenant_id = $1 and id = $2`, [tenant(tenantId), id]);
    return rows[0] ? mapRegistration(rows[0]) : null;
  }

  async get_trusted_assessor_version(tenantId: string, id: string): Promise<TrustedAssessorRegistrationVersion | null> {
    return this.getTrustedAssessorVersion(tenantId, id);
  }

  async submitAssessment(input: SubmitAssessmentInput, context: TrustedAssessorVersionContext): Promise<RunAssessmentReceipt> {
    assertSubmissionHasNoAuthorityFields(input);
    if (context === null || typeof context !== "object" || Array.isArray(context)) {
      throw new PersistenceError("invalid_input", "trusted assessor context must be an object");
    }
    const raw = input as unknown as Record<string, unknown>;
    const contextTenant = context.tenant_id === undefined ? undefined : tenant(context.tenant_id);
    const inputTenant = input.tenant_id === undefined ? undefined : tenant(input.tenant_id);
    if (contextTenant !== undefined && inputTenant !== undefined && contextTenant !== inputTenant) {
      throw new PersistenceError("assessment_validation_failed", "assessment tenant does not match the trusted assessor context", { tenant_id: inputTenant });
    }
    const tenantId = contextTenant ?? inputTenant ?? tenant(undefined);
    const coreAssessment = normalizeCoreAssessment(input);
    const normalized = coreAssessment.value;
    const runId = stringInput(normalized.runId, "run_id", 1, 512);
    const policyId = stringInput(raw.policy_version_id, "policy_version_id", 1, 128);
    const requestKey = stringInput(aliasedScalar(raw, ["request_idempotency_key", "requestIdempotencyKey"], "request_idempotency_key"), "request_idempotency_key", 8, 512);
    const kind = enumValue(normalized.assessmentKind, KINDS, "assessment_kind");
    const verdict = enumValue(normalized.verdict, VERDICTS, "verdict");
    const failureStage = enumValue(normalized.failureStage, FAILURE_STAGES, "failure_stage");
    const failureClass = enumValue(normalized.failureClass, FAILURE_CLASSES, "failure_class");
    const stopReason = enumValue(normalized.stopReason, STOP_REASONS, "stop_reason");
    const startedAt = timestamp(normalized.startedAt, "started_at");
    const completedAt = timestamp(normalized.completedAt, "completed_at");
    const summary = stringInput(normalized.summary, "summary", 0, 4_096);
    const metadata = object(normalized.metadata, "metadata");
    const reassessmentOf = input.reassessment_of ?? null;
    const budgets = normalizeBudgets(normalized.declaredBudgets as readonly DeclaredBudgetInput[]);
    const usage = normalizeUsage(normalized.usage as unknown as readonly UsageObservationInput[]);
    const artifacts = normalizeArtifacts(normalized.artifactReferences as unknown as readonly AssessmentArtifactReferenceInput[]);
    const authorityId = stringInput(context.assessor_registration_version_id, "assessor_registration_version_id", 1, 128);
    const requestHash = payloadHash({
      core_request_hash: coreAssessment.hash, run_id: runId, policy_version_id: policyId,
      reassessment_of: reassessmentOf,
      assessor_registration_version_id: authorityId,
    });

    return this.withTransaction(async (client) => {
      await client.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [`m8:assessment:${tenantId}:${requestKey}`]);
      const existing = await this.query<DbAssessmentRow>(client, `select ra.id, ra.tenant_id, ra.run_id, r.wire_run_id, r.status as run_status, r.completed_at as run_completed_at, ra.policy_version_id, ra.assessor_registration_version_id, ra.assessor_id, ra.assessor_type, ra.assessor_independence, ra.request_idempotency_key, ra.request_payload_hash, ra.assessment_kind, ra.verdict, ra.failure_stage, ra.failure_class, ra.stop_reason, ra.started_at, ra.completed_at, ra.summary, ra.metadata, ra.reassessment_of, ra.created_at from agent_feed.run_assessments ra join agent_feed.runs r on r.tenant_id = ra.tenant_id and r.id = ra.run_id join agent_feed.assessment_receipt_seals ars on ars.tenant_id = ra.tenant_id and ars.assessment_id = ra.id where ra.tenant_id = $1 and ra.request_idempotency_key = $2 for update`, [tenantId, requestKey]);
      if (existing[0]) {
        if (existing[0].request_payload_hash !== requestHash) throw new PersistenceError("assessment_conflict", "assessment idempotency key was reused with a different payload");
        return this.loadReceipt(client, existing[0].tenant_id, existing[0].id);
      }
      const runs = await this.query<{ id: string; wire_run_id: string; status: RunAssessmentReceipt["run_status"]; completed_at: Date | string | null }>(client, `select id, wire_run_id, status, completed_at from agent_feed.runs where tenant_id = $1 and wire_run_id = $2 for update`, [tenantId, runId]);
      const run = runs[0];
      if (!run) throw new PersistenceError("run_not_found", `run ${runId} was not found`, { run_id: runId });
      const policies = await this.query<DbPolicyRow>(client, `select id, tenant_id, policy_key, version, policy_json, policy_canonical_json, policy_hash, metadata, created_at from agent_feed.validation_policy_versions where tenant_id = $1 and id = $2 for update`, [tenantId, policyId]);
      const policy = policies[0];
      if (!policy) throw new PersistenceError("policy_version_not_found", `policy version ${policyId} was not found`, { policy_version_id: policyId });
      if ((normalized.policyKey !== null && normalized.policyKey !== policy.policy_key)
        || (normalized.policyVersion !== null && normalized.policyVersion !== String(policy.version))) {
        throw new PersistenceError("assessment_validation_failed", "assessment policy identity does not match the referenced policy version", { policy_version_id: policyId });
      }
      const registrations = await this.query<DbRegistrationRow>(client, `select id, tenant_id, assessor_id, version, assessor_type, independence, trusted_key_digest, subject_digest, status, supersedes_id, metadata, created_at from agent_feed.trusted_assessor_registration_versions where tenant_id = $1 and id = $2 for update`, [tenantId, authorityId]);
      const registration = registrations[0];
      if (!registration) throw new PersistenceError("assessor_registration_not_found", `trusted assessor version ${authorityId} was not found`, { assessor_registration_version_id: authorityId });
      if (registration.status !== "active") throw new PersistenceError("assessment_validation_failed", "revoked or replaced assessor versions cannot submit assessments");
      const normalizedPolicy = corePolicy(policy.policy_json);
      if (normalizedPolicy.hash !== policy.policy_hash) throw new PersistenceError("assessment_validation_failed", "persisted policy hash is not canonical");
      policyAllows(normalizedPolicy.policy, kind, registration.independence);
      if (policyRequiresBudget(normalizedPolicy.policy) && !budgets.some((budget) => budget.state === "declared")) throw new PersistenceError("assessment_validation_failed", "validation policy requires a declared budget");
      if (normalizedPolicy.policy.declaredBudgetRequirement === "not_applicable" && budgets.some((budget) => budget.state === "declared")) {
        throw new PersistenceError("assessment_validation_failed", "validation policy does not allow a declared budget");
      }
      if (reassessmentOf !== null) {
        const prior = await this.query<{ run_id: string; policy_version_id: string }>(client, `select run_id, policy_version_id from agent_feed.run_assessments where tenant_id = $1 and id = $2`, [tenantId, reassessmentOf]);
        if (!prior[0] || prior[0].run_id !== run.id || prior[0].policy_version_id !== policyId) throw new PersistenceError("assessment_validation_failed", "reassessment_of must reference the same tenant, run, and policy version");
      }
      const assessments = await this.query<DbAssessmentRow>(client, `insert into agent_feed.run_assessments (id, tenant_id, run_id, policy_version_id, assessor_registration_version_id, assessor_id, assessor_type, assessor_independence, request_idempotency_key, request_payload_hash, assessment_kind, verdict, failure_stage, failure_class, stop_reason, started_at, completed_at, summary, metadata, reassessment_of) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19::jsonb, $20) returning id, tenant_id, run_id, policy_version_id, assessor_registration_version_id, assessor_id, assessor_type, assessor_independence, request_idempotency_key, request_payload_hash, assessment_kind, verdict, failure_stage, failure_class, stop_reason, started_at, completed_at, summary, metadata, reassessment_of, created_at`, [randomUUID(), tenantId, run.id, policyId, registration.id, registration.assessor_id, registration.assessor_type, registration.independence, requestKey, requestHash, kind, verdict, failureStage, failureClass, stopReason, startedAt, completedAt, summary, JSON.stringify(metadata), reassessmentOf]);
      const assessment = assessments[0];
      if (!assessment) throw new PersistenceError("storage_error", "database returned no assessment row");
      for (const budget of budgets) {
        await client.query(`insert into agent_feed.assessment_declared_budgets (tenant_id, assessment_id, budget_key, state, limit_value, unit, metadata) values ($1, $2, $3, $4, $5, $6, $7::jsonb)`, [tenantId, assessment.id, budget.budgetKey, budget.state, budget.limitValue, budget.unit, JSON.stringify(budget.metadata)]);
      }
      for (const item of usage) {
        await client.query(`insert into agent_feed.assessment_usage_observations (tenant_id, assessment_id, usage_key, metric, state, value, unit, provenance, provenance_details, observed_at, metadata) values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11::jsonb)`, [tenantId, assessment.id, item.usageKey, item.metric, item.state, item.value, item.unit, item.provenance, JSON.stringify(item.provenanceDetails), item.observedAt, JSON.stringify(item.metadata)]);
      }
      for (const artifact of artifacts) {
        await client.query(`insert into agent_feed.assessment_artifact_references (tenant_id, assessment_id, artifact_key, artifact_kind, artifact_hash, identity, reference, provenance, media_type, size_bytes, metadata) values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11::jsonb)`, [tenantId, assessment.id, artifact.artifactKey, artifact.artifactKind, artifact.artifactHash, artifact.identity, artifact.reference, JSON.stringify(artifact.provenance), artifact.mediaType, artifact.sizeBytes, JSON.stringify(artifact.metadata)]);
      }
      await client.query(`insert into agent_feed.assessment_receipt_seals (tenant_id, assessment_id) values ($1, $2)`, [tenantId, assessment.id]);
      return this.loadReceipt(client, tenantId, assessment.id);
    });
  }

  async submit_assessment(input: SubmitAssessmentInput, context: TrustedAssessorVersionContext): Promise<RunAssessmentReceipt> {
    return this.submitAssessment(input, context);
  }

  async getAssessment(tenantId: string, id: string): Promise<RunAssessmentReceipt | null> {
    try {
      return await this.loadReceipt(this.pool, tenant(tenantId), id);
    } catch (error) {
      if (error instanceof PersistenceError && error.code === "assessment_not_found") return null;
      throw error;
    }
  }

  async get_assessment(tenantId: string, id: string): Promise<RunAssessmentReceipt | null> {
    return this.getAssessment(tenantId, id);
  }

  async listAssessments(options: AssessmentListOptions): Promise<RunAssessmentReceipt[]> {
    const tenantId = tenant(options.tenant_id);
    const limit = options.limit ?? 100;
    const offset = options.offset ?? 0;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new PersistenceError("invalid_input", "assessment list limit must be between 1 and 500");
    if (!Number.isSafeInteger(offset) || offset < 0) throw new PersistenceError("invalid_input", "assessment list offset must be non-negative");
    const params: unknown[] = [tenantId];
    const predicates = ["ra.tenant_id = $1"];
    if (options.run_id !== undefined) { params.push(options.run_id); predicates.push(`r.wire_run_id = $${params.length}`); }
    if (options.policy_version_id !== undefined) { params.push(options.policy_version_id); predicates.push(`ra.policy_version_id = $${params.length}`); }
    params.push(limit, offset);
    const rows = await this.query<DbAssessmentRow>(this.pool, `select ra.id, ra.tenant_id, ra.run_id, r.wire_run_id, r.status as run_status, r.completed_at as run_completed_at, ra.policy_version_id, ra.assessor_registration_version_id, ra.assessor_id, ra.assessor_type, ra.assessor_independence, ra.request_idempotency_key, ra.request_payload_hash, ra.assessment_kind, ra.verdict, ra.failure_stage, ra.failure_class, ra.stop_reason, ra.started_at, ra.completed_at, ra.summary, ra.metadata, ra.reassessment_of, ra.created_at from agent_feed.run_assessments ra join agent_feed.runs r on r.tenant_id = ra.tenant_id and r.id = ra.run_id join agent_feed.assessment_receipt_seals ars on ars.tenant_id = ra.tenant_id and ars.assessment_id = ra.id where ${predicates.join(" and ")} order by ra.created_at, ra.id limit $${params.length - 1} offset $${params.length}`, params);
    return Promise.all(rows.map((row) => this.loadReceipt(this.pool, tenantId, row.id)));
  }

  async list_assessments(options: AssessmentListOptions): Promise<RunAssessmentReceipt[]> {
    return this.listAssessments(options);
  }

  private async loadReceipt(client: PgPool | PoolClient, tenantId: string, id: string): Promise<RunAssessmentReceipt> {
    const rows = await this.query<DbAssessmentRow>(client, `select ra.id, ra.tenant_id, ra.run_id, r.wire_run_id, r.status as run_status, r.completed_at as run_completed_at, ra.policy_version_id, ra.assessor_registration_version_id, ra.assessor_id, ra.assessor_type, ra.assessor_independence, ra.request_idempotency_key, ra.request_payload_hash, ra.assessment_kind, ra.verdict, ra.failure_stage, ra.failure_class, ra.stop_reason, ra.started_at, ra.completed_at, ra.summary, ra.metadata, ra.reassessment_of, ra.created_at from agent_feed.run_assessments ra join agent_feed.runs r on r.tenant_id = ra.tenant_id and r.id = ra.run_id join agent_feed.assessment_receipt_seals ars on ars.tenant_id = ra.tenant_id and ars.assessment_id = ra.id where ra.tenant_id = $1 and ra.id = $2`, [tenantId, id]);
    const row = rows[0];
    if (!row) throw new PersistenceError("assessment_not_found", `assessment ${id} was not found`, { assessment_id: id });
    const [budgets, usage, artifacts] = await Promise.all([
      this.query<DbBudgetRow>(client, `select id, tenant_id, assessment_id, budget_key, state, limit_value, unit, metadata, created_at from agent_feed.assessment_declared_budgets where tenant_id = $1 and assessment_id = $2 order by budget_key`, [tenantId, id]),
      this.query<DbUsageRow>(client, `select id, tenant_id, assessment_id, usage_key, metric, state, value, unit, provenance, provenance_details, observed_at, metadata, created_at from agent_feed.assessment_usage_observations where tenant_id = $1 and assessment_id = $2 order by usage_key`, [tenantId, id]),
      this.query<DbArtifactRow>(client, `select id, tenant_id, assessment_id, artifact_key, artifact_kind, artifact_hash, identity, reference, provenance, media_type, size_bytes, metadata, created_at from agent_feed.assessment_artifact_references where tenant_id = $1 and assessment_id = $2 order by artifact_key`, [tenantId, id]),
    ]);
    return {
      id: row.id,
      tenant_id: row.tenant_id,
      run_id: row.wire_run_id,
      policy_version_id: row.policy_version_id,
      assessor_registration_version_id: row.assessor_registration_version_id,
      assessor_id: row.assessor_id,
      assessor_type: row.assessor_type,
      assessor_independence: row.assessor_independence,
      request_idempotency_key: row.request_idempotency_key,
      request_payload_hash: row.request_payload_hash,
      assessment_kind: row.assessment_kind,
      verdict: row.verdict,
      failure_stage: row.failure_stage,
      failure_class: row.failure_class,
      stop_reason: row.stop_reason,
      started_at: iso(row.started_at),
      completed_at: iso(row.completed_at),
      summary: row.summary,
      metadata: object(row.metadata, "assessment metadata"),
      reassessment_of: row.reassessment_of,
      created_at: iso(row.created_at) ?? "",
      run_status: row.run_status,
      run_completed_at: iso(row.run_completed_at),
      technical_run_status: row.run_status,
      technical_completed_at: iso(row.run_completed_at),
      declared_budgets: budgets.map(mapBudget),
      usage_observations: usage.map(mapUsage),
      artifact_references: artifacts.map(mapArtifact),
    };
  }

  private async withTransaction<T>(operation: (client: PgTransactionClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const result = await operation(client);
      await client.query("commit");
      return result;
    } catch (error) {
      try { await client.query("rollback"); } catch { /* preserve original failure */ }
      throw mapError(error);
    } finally {
      client.release();
    }
  }

  private async query<T extends QueryResultRow>(client: PgPool | PoolClient, text: string, values: readonly unknown[] = []): Promise<T[]> {
    const result = await client.query<T>(text, values as unknown[]);
    return result.rows;
  }
}

/** Compatibility spelling used by some composition roots. */
export const PostgresJobProofRepository = PostgresAssessmentRepository;
