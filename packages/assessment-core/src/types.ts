/** JSON values accepted by the assessment sidecar.  The core never accepts
 * class instances, functions, or other host values at an adapter boundary. */
export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | readonly JsonValue[];
export type JsonObject = { readonly [key: string]: JsonValue };

export const VALIDATION_POLICY_SCHEMA_VERSION = "agent-feed.validation-policy.v1" as const;
export const ASSESSMENT_SCHEMA_VERSION = "agent-feed.assessment.v1" as const;
export const ASSESSMENT_REQUEST_SCHEMA_VERSION = ASSESSMENT_SCHEMA_VERSION;

export const MAX_POLICY_KINDS = 32 as const;
export const MAX_BUDGET_DECLARATIONS = 64 as const;
export const MAX_USAGE_OBSERVATIONS = 64 as const;
export const MAX_ARTIFACT_REFERENCES = 64 as const;
export const MAX_SUMMARY_LENGTH = 4_096 as const;
export const MAX_IDENTIFIER_LENGTH = 256 as const;
export const MAX_OPAQUE_REFERENCE_LENGTH = 1_024 as const;
export const MAX_METADATA_DEPTH = 6 as const;
export const MAX_METADATA_KEYS = 64 as const;
export const MAX_METADATA_ARRAY_LENGTH = 64 as const;
export const MAX_METADATA_STRING_LENGTH = 4_096 as const;

export type AssessorType =
  | "producer_self_check"
  | "independent_agent"
  | "human_reviewer"
  | "validation_service";

export type AssessorIndependence = "self" | "independent" | "unknown";

export type AssessmentKind =
  | "technical"
  | "quality"
  | "security"
  | "compliance"
  | "operational";

export type AssessmentVerdict = "passed" | "failed" | "inconclusive" | "unknown";

export type FailureStage =
  | "none"
  | "setup"
  | "execution"
  | "collection"
  | "validation"
  | "teardown"
  | "unknown";

export type FailureClass =
  | "none"
  | "configuration"
  | "authentication"
  | "authorization"
  | "dependency"
  | "timeout"
  | "budget"
  | "rate_limit"
  | "provider"
  | "network"
  | "contract"
  | "data_quality"
  | "security"
  | "cancelled"
  | "unknown";

export type StopReason =
  | "completed"
  | "policy_failed"
  | "budget_exhausted"
  | "timeout"
  | "cancelled"
  | "assessor_error"
  | "dependency_unavailable"
  | "manual_stop"
  | "unknown";

export type UsageMetric =
  | "wall_time_ms"
  | "input_tokens"
  | "output_tokens"
  | "cost_microunits"
  | "tool_calls"
  | "network_requests"
  | "artifact_bytes";

export type TelemetryState = "observed" | "unknown" | "not_applicable";

export type UsageProvenanceType =
  | "provider_reported"
  | "executor_measured"
  | "assessor_observed"
  | "operator_entered"
  | "derived"
  | "unknown";

export type DeclaredBudgetState = "declared" | "unknown" | "not_applicable";
export type DeclaredBudgetRequirement = "required" | "optional" | "not_applicable";

export const ASSESSOR_TYPES: readonly AssessorType[] = [
  "producer_self_check",
  "independent_agent",
  "human_reviewer",
  "validation_service",
];
export const ASSESSOR_INDEPENDENCE_VALUES: readonly AssessorIndependence[] = ["self", "independent", "unknown"];
export const ASSESSMENT_KINDS: readonly AssessmentKind[] = ["technical", "quality", "security", "compliance", "operational"];
export const ASSESSMENT_VERDICTS: readonly AssessmentVerdict[] = ["passed", "failed", "inconclusive", "unknown"];
export const FAILURE_STAGES: readonly FailureStage[] = ["none", "setup", "execution", "collection", "validation", "teardown", "unknown"];
export const FAILURE_CLASSES: readonly FailureClass[] = [
  "none", "configuration", "authentication", "authorization", "dependency", "timeout", "budget", "rate_limit",
  "provider", "network", "contract", "data_quality", "security", "cancelled", "unknown",
];
export const STOP_REASONS: readonly StopReason[] = [
  "completed", "policy_failed", "budget_exhausted", "timeout", "cancelled", "assessor_error", "dependency_unavailable", "manual_stop", "unknown",
];
export const USAGE_METRICS: readonly UsageMetric[] = ["wall_time_ms", "input_tokens", "output_tokens", "cost_microunits", "tool_calls", "network_requests", "artifact_bytes"];
export const TELEMETRY_STATES: readonly TelemetryState[] = ["observed", "unknown", "not_applicable"];
export const USAGE_PROVENANCE_TYPES: readonly UsageProvenanceType[] = ["provider_reported", "executor_measured", "assessor_observed", "operator_entered", "derived", "unknown"];
export const DECLARED_BUDGET_STATES: readonly DeclaredBudgetState[] = ["declared", "unknown", "not_applicable"];
export const DECLARED_BUDGET_REQUIREMENTS: readonly DeclaredBudgetRequirement[] = ["required", "optional", "not_applicable"];

/** A policy is authority/configuration input, never an assessment claim. */
export interface ValidationPolicyInput {
  readonly schemaVersion?: string;
  readonly policyKey?: string | null;
  readonly policyVersion?: string | null;
  readonly policy_key?: string | null;
  readonly policy_version?: string | null;
  readonly requiredAssessmentKinds?: readonly AssessmentKind[];
  readonly required_assessment_kinds?: readonly AssessmentKind[];
  readonly requiredKinds?: readonly AssessmentKind[];
  readonly minimumIndependence?: "self" | "independent";
  readonly minimum_independence?: "self" | "independent";
  readonly minimumAssessorIndependence?: "self" | "independent";
  readonly minimum_assessor_independence?: "self" | "independent";
  readonly declaredBudgetRequirement?: DeclaredBudgetRequirement;
  readonly declared_budget_requirement?: DeclaredBudgetRequirement;
  readonly budgetRequirement?: DeclaredBudgetRequirement;
  readonly budget_requirement?: DeclaredBudgetRequirement;
  readonly declaredBudgetRequirements?: JsonObject;
  readonly declared_budget_requirements?: JsonObject;
  readonly metadata?: JsonObject;
}

export interface ValidationPolicy {
  readonly schemaVersion: typeof VALIDATION_POLICY_SCHEMA_VERSION;
  readonly policyKey: string | null;
  readonly policyVersion: string | null;
  readonly requiredAssessmentKinds: readonly AssessmentKind[];
  readonly minimumIndependence: "self" | "independent";
  readonly declaredBudgetRequirement: DeclaredBudgetRequirement;
  readonly metadata: JsonObject;
}

/** Trusted, adapter-resolved authority.  This type is intentionally separate
 * from AssessmentSubmissionInput so a producer cannot submit its own claim. */
export interface AssessorAuthorityInput {
  readonly assessorType: AssessorType;
  readonly independence: AssessorIndependence;
}

export interface AssessorAuthority {
  readonly assessorType: AssessorType;
  readonly independence: AssessorIndependence;
}

export interface DeclaredBudgetInput {
  readonly budgetKey?: string;
  readonly budget_key?: string;
  readonly state?: DeclaredBudgetState;
  readonly budgetState?: DeclaredBudgetState;
  readonly budget_state?: DeclaredBudgetState;
  readonly limit?: number | null;
  readonly limitValue?: number | null;
  readonly limit_value?: number | null;
  readonly unit?: string | null;
  readonly metadata?: JsonObject;
}

export interface DeclaredBudget {
  readonly budgetKey: string;
  readonly state: DeclaredBudgetState;
  readonly limit: number | null;
  readonly unit: string | null;
  readonly metadata: JsonObject;
}

export interface UsageObservationInput {
  readonly metric: UsageMetric;
  readonly usageKey?: string;
  readonly usage_key?: string;
  readonly state?: TelemetryState;
  readonly telemetryState?: TelemetryState;
  readonly telemetry_state?: TelemetryState;
  readonly value?: number | null;
  readonly provenance?: UsageProvenanceType;
  readonly usageProvenance?: UsageProvenanceType;
  readonly usage_provenance?: UsageProvenanceType;
  readonly provenanceDetails?: JsonObject;
  readonly provenance_details?: JsonObject;
  readonly unit?: string | null;
  readonly observedAt?: string | null;
  readonly observed_at?: string | null;
  readonly metadata?: JsonObject;
}

export interface UsageObservation {
  readonly metric: UsageMetric;
  readonly usageKey?: string;
  readonly state: TelemetryState;
  readonly value: number | null;
  readonly provenance: UsageProvenanceType;
  readonly provenanceDetails?: JsonObject;
  readonly unit: string | null;
  readonly observedAt?: string | null;
  readonly metadata: JsonObject;
}

export interface ArtifactReferenceInput {
  readonly artifactKey?: string;
  readonly artifact_key?: string;
  readonly key?: string;
  readonly artifactKind?: string;
  readonly artifact_kind?: string;
  readonly kind?: string;
  readonly sha256?: string;
  readonly artifactHash?: string;
  readonly artifact_hash?: string;
  readonly hash?: string;
  readonly reference?: string | null;
  readonly ref?: string;
  readonly artifactRef?: string;
  readonly artifact_ref?: string;
  readonly identity?: string | null;
  readonly byteLength?: number | null;
  readonly byte_length?: number | null;
  readonly sizeBytes?: number | null;
  readonly size_bytes?: number | null;
  readonly mediaType?: string | null;
  readonly media_type?: string | null;
  readonly provenance?: string | JsonObject | null;
  readonly metadata?: JsonObject;
}

export interface ArtifactReference {
  readonly artifactKey: string;
  readonly artifactKind: string;
  /** Exactly 64 lower-case hexadecimal characters. */
  readonly sha256: string;
  readonly reference: string | null;
  readonly identity: string | null;
  readonly byteLength: number | null;
  readonly mediaType: string | null;
  readonly provenance: string | JsonObject | null;
  readonly metadata: JsonObject;
}

/** Submission data deliberately excludes assessor authority and run status. */
export interface AssessmentSubmissionInput {
  readonly schemaVersion?: string;
  readonly runId?: string;
  readonly run_id?: string;
  readonly policyKey?: string | null;
  readonly policyVersion?: string | null;
  readonly policy_key?: string | null;
  readonly policy_version?: string | null;
  readonly assessmentKind?: AssessmentKind;
  readonly assessment_kind?: AssessmentKind;
  readonly kind?: AssessmentKind;
  readonly verdict?: AssessmentVerdict;
  readonly failureStage?: FailureStage;
  readonly failure_stage?: FailureStage;
  readonly failureClass?: FailureClass;
  readonly failure_class?: FailureClass;
  readonly stopReason?: StopReason;
  readonly stop_reason?: StopReason;
  readonly startedAt?: string | null;
  readonly started_at?: string | null;
  readonly completedAt?: string | null;
  readonly completed_at?: string | null;
  readonly summary?: string;
  readonly metadata?: JsonObject;
  readonly declaredBudgets?: readonly DeclaredBudgetInput[];
  readonly declared_budgets?: readonly DeclaredBudgetInput[];
  readonly usage?: readonly UsageObservationInput[] | Readonly<Partial<Record<UsageMetric, UsageObservationInput>>>;
  readonly usageObservations?: readonly UsageObservationInput[];
  readonly usage_observations?: readonly UsageObservationInput[];
  readonly artifactReferences?: readonly ArtifactReferenceInput[];
  readonly artifact_references?: readonly ArtifactReferenceInput[];
  /** Accepted for idempotency at an adapter boundary but intentionally not
   * represented in the canonical request payload or its hash. */
  readonly requestIdempotencyKey?: string;
  readonly request_idempotency_key?: string;
}

export interface AssessmentSubmission {
  readonly schemaVersion: typeof ASSESSMENT_SCHEMA_VERSION;
  readonly runId: string;
  readonly policyKey: string | null;
  readonly policyVersion: string | null;
  readonly assessmentKind: AssessmentKind;
  readonly verdict: AssessmentVerdict;
  readonly failureStage: FailureStage;
  readonly failureClass: FailureClass;
  readonly stopReason: StopReason;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly summary: string;
  readonly metadata: JsonObject;
  readonly declaredBudgets: readonly DeclaredBudget[];
  readonly usage: readonly UsageObservation[];
  readonly artifactReferences: readonly ArtifactReference[];
}

export type Assessment = AssessmentSubmission;
export type AssessmentInput = AssessmentSubmissionInput;

export type ValidationIssueCode =
  | "invalid_object"
  | "unknown_field"
  | "required_string"
  | "invalid_schema_version"
  | "invalid_policy"
  | "invalid_assessment"
  | "invalid_enum"
  | "invalid_timestamp"
  | "invalid_time_order"
  | "invalid_summary"
  | "invalid_metadata"
  | "metadata_limit_exceeded"
  | "credential_like_content"
  | "invalid_budget"
  | "budget_limit_invalid"
  | "budget_limit_not_allowed"
  | "budget_limit_exceeded"
  | "duplicate_budget"
  | "invalid_usage"
  | "usage_value_invalid"
  | "usage_value_not_allowed"
  | "usage_provenance_invalid"
  | "duplicate_usage_metric"
  | "usage_limit_exceeded"
  | "invalid_artifact"
  | "invalid_artifact_hash"
  | "invalid_artifact_reference"
  | "artifact_content_forbidden"
  | "duplicate_artifact"
  | "artifact_limit_exceeded"
  | "policy_incompatible"
  | "assessor_authority_invalid"
  | "assessor_authority_unavailable";

export interface ValidationIssue {
  readonly code: ValidationIssueCode | string;
  readonly path: string;
  readonly message: string;
}

export interface ValidationError {
  readonly code: ValidationIssueCode | string;
  readonly message: string;
  readonly path?: string;
}

export type ValidationResult<T> =
  | { readonly ok: true; readonly value: T; readonly issues: readonly [] }
  | { readonly ok: false; readonly error: ValidationError; readonly issues: readonly ValidationIssue[] };

export class AssessmentCoreError extends Error {
  readonly code: string;
  readonly path?: string;
  readonly issues: readonly ValidationIssue[];

  constructor(code: string, message: string, options: { path?: string; issues?: readonly ValidationIssue[] } = {}) {
    super(message);
    this.name = "AssessmentCoreError";
    this.code = code;
    if (options.path !== undefined) this.path = options.path;
    this.issues = options.issues ?? [];
  }

  toJSON(): ValidationError & { issues: readonly ValidationIssue[] } {
    return {
      code: this.code,
      message: this.message,
      ...(this.path === undefined ? {} : { path: this.path }),
      issues: this.issues,
    };
  }
}

export interface PolicyCompatibility {
  readonly compatible: boolean;
  readonly reason:
    | "compatible"
    | "assessment_kind_not_required"
    | "minimum_independence_not_met"
    | "unknown_independence"
    | "producer_cannot_claim_independence"
    | "declared_budget_required"
    | "declared_budget_not_applicable"
    | "invalid_policy"
    | "invalid_assessment"
    | "invalid_authority";
  readonly missingAssessmentKinds: readonly AssessmentKind[];
  readonly normalizedPolicy?: ValidationPolicy;
  readonly normalizedAssessment?: AssessmentSubmission;
  readonly authority?: AssessorAuthority;
}

export interface AssessmentPolicyEvaluationInput {
  readonly policy: ValidationPolicy | ValidationPolicyInput;
  readonly assessments: readonly AssessmentSubmissionInput[];
  readonly authorities: readonly AssessorAuthorityInput[];
}

export interface AssessmentPolicyEvaluation {
  readonly compatible: boolean;
  readonly missingAssessmentKinds: readonly AssessmentKind[];
  readonly results: readonly PolicyCompatibility[];
}
