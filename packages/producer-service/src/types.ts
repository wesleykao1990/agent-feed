/**
 * Adapter-neutral lifecycle types owned by the producer application boundary.
 * Storage adapters satisfy this port structurally; this package must remain
 * independently buildable without importing PostgreSQL implementation code.
 */
export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export type JsonObject = { [key: string]: JsonValue };

export type RunStatus = "running" | "completed" | "partial" | "failed" | "cancelled";
export type TerminalRunStatus = Exclude<RunStatus, "running">;

export interface Scope {
  source_ids: string[];
  subjects: string[];
  queries: string[];
  metadata: JsonObject;
}

export interface Producer {
  producer_id: string;
  type: "chatgpt" | "claude" | "codex" | "custom_agent" | "human" | "automation";
  name: string;
  version: string | null;
}

export interface Task {
  task_type: string;
  definition_id: string | null;
  definition_version: string | null;
}

export interface FindingPayload extends JsonObject {
  finding_id: string;
  finding_type: string;
  title: string;
  summary: string;
  subjects: JsonValue[];
  evidence_refs: string[];
  security_flags: string[];
}

export interface EvidencePayload extends JsonObject {
  evidence_id: string;
  kind: "web" | "document" | "email" | "api" | "social_post" | "database" | "human_observation" | "file" | "other";
  source: JsonObject;
  captured_at: string;
  published_at: string | null;
  locator: JsonValue;
  excerpt: string | null;
  content_hash: string | null;
  artifact: JsonObject;
  handling: {
    contains_personal_data: boolean;
    contains_secrets: boolean;
    redistribution_restricted: boolean;
  };
  metadata: JsonObject;
}

export interface BeginRunRequest {
  protocol_version: "0.1";
  tenant_id?: string;
  idempotency_key: string;
  stream_id: string;
  producer: Producer;
  task: Task;
  expected_scope: Scope;
  started_at: string;
  parent_run_id: string | null;
  metadata: JsonObject;
  /** Optional deterministic ID for trusted callers and tests; not required by the wire contract. */
  run_id?: string;
}

export interface SubmitBatchRequest {
  protocol_version: "0.1";
  tenant_id?: string;
  run_id: string;
  batch_id: string;
  idempotency_key: string;
  sequence_number: number;
  submitted_at: string;
  findings: FindingPayload[];
  evidence: EvidencePayload[];
  metadata: JsonObject;
}

export interface CompleteRunRequest {
  protocol_version: "0.1";
  tenant_id?: string;
  run_id: string;
  idempotency_key: string;
  status: TerminalRunStatus;
  completed_at: string;
  actual_scope: Scope;
  stats: {
    sources_attempted: number;
    sources_succeeded: number;
    findings_submitted: number;
    evidence_submitted: number;
    batches_submitted: number;
  };
  errors: JsonValue[];
  metadata: JsonObject;
}

export interface RunEnvelope {
  protocol_version: "0.1";
  run_id: string;
  stream_id: string;
  producer: Producer;
  task: Task;
  started_at: string;
  completed_at: string | null;
  status: RunStatus;
  expected_scope: Scope;
  actual_scope: Scope | null;
  stats: CompleteRunRequest["stats"];
  parent_run_id: string | null;
  error_summary: string | null;
  metadata: JsonObject;
}

export interface StoredBatch {
  id: string;
  run_id: string;
  batch_id: string;
  idempotency_key: string;
  sequence_number: number;
  payload_hash: string;
  submitted_at: string;
  metadata: JsonObject;
  accepted_at: string;
}

export interface StoredFinding {
  id: string;
  run_id: string;
  batch_id: string;
  finding: FindingPayload;
  created_at: string;
}

export interface StoredEvidence {
  id: string;
  run_id: string;
  batch_id: string;
  evidence: EvidencePayload;
  created_at: string;
}

export interface RunStats {
  sources_attempted: number;
  sources_succeeded: number;
  findings_submitted: number;
  evidence_submitted: number;
  batches_submitted: number;
}

export interface RunRecord {
  run_id: string;
  tenant_id: string;
  trace_id: string;
  stream_id: string;
  producer_id: string;
  begin_idempotency_key: string;
  begin_payload_hash: string;
  complete_idempotency_key: string | null;
  complete_payload_hash: string | null;
  status: RunStatus;
  started_at: string;
  completed_at: string | null;
  envelope: RunEnvelope;
  batches: StoredBatch[];
  findings: StoredFinding[];
  evidence: StoredEvidence[];
  stats: RunStats;
}

export type PersistenceErrorCode =
  | "idempotency_payload_conflict"
  | "run_not_found"
  | "run_id_conflict"
  | "terminal_run_immutable"
  | "batch_not_found"
  | "batch_id_conflict"
  | "batch_sequence_not_increasing"
  | "duplicate_finding"
  | "duplicate_evidence"
  | "unresolved_evidence_ref"
  | "completion_before_start"
  | "invalid_scope_stats"
  | "completion_counts_do_not_reconcile"
  | "invalid_input"
  | "storage_error";

export interface ProducerPersistence {
  beginRun(input: BeginRunRequest): Promise<RunRecord>;
  submitBatch(input: SubmitBatchRequest): Promise<RunRecord>;
  completeRun(input: CompleteRunRequest): Promise<RunRecord>;
  getRunForTenant(tenantId: string, runId: string): Promise<RunRecord | null>;
  /** Adapter-owned connectivity probe. Application code must not issue SQL. */
  checkReady?: () => Promise<void>;
}

export interface ProducerPrincipal {
  tenant_id: string;
  producer_id: string;
  allowed_stream_ids: readonly string[];
  credential_id?: string;
}

export interface ProducerCredential {
  tenant_id: string;
  producer_id: string;
  secret: string;
  allowed_stream_ids: readonly string[];
  credential_id?: string;
  expires_at?: string | number | Date;
}

export interface ProducerAuthenticationRequest {
  authorization?: string;
  now_seconds?: number;
}

export interface ProducerAuthenticator {
  authenticate(request: ProducerAuthenticationRequest): ProducerPrincipal | null;
}

export interface RateLimitOptions {
  max_requests_per_minute?: number;
  window_ms?: number;
  burst?: number;
  burst_window_ms?: number;
  now?: () => number;
}

export interface RateLimitDecision {
  allowed: boolean;
  remaining: number;
  retry_after_seconds: number;
}

export interface SecurityPolicy {
  max_body_bytes: number;
  max_findings_per_batch: number;
  max_evidence_per_batch: number;
  max_evidence_excerpt_characters: number;
  max_evidence_metadata_bytes: number;
  reject_secrets: boolean;
  reject_personal_data: boolean;
  quarantine_personal_data: boolean;
  quarantine_hostile_findings: boolean;
  on_quarantine?: (event: QuarantineEvent) => void;
}

export interface QuarantineEvent {
  kind: "evidence" | "finding" | "payload";
  reason: "secret_bearing_evidence" | "secret_field" | "personal_data" | "security_flag";
  run_id?: string;
  evidence_id?: string;
  finding_id?: string;
  flags?: readonly string[];
  field_path?: string;
}

export interface ProducerServiceOptions {
  persistence: ProducerPersistence;
  authenticator: ProducerAuthenticator;
  rate_limiter?: {
    assertAllowed(key: string): RateLimitDecision;
    max_requests_per_minute: number;
    burst: number;
    burst_window_ms: number;
  };
  rate_limit?: RateLimitOptions;
  security?: Partial<SecurityPolicy>;
  now?: () => Date;
}

export interface ProducerServiceResult {
  run: RunRecord;
}

export interface ProtocolValidationError {
  path: string;
  message: string;
}

/**
 * A generated schema package can be plugged into the service without making
 * the service depend on a schema generator or AJV at runtime. The default
 * validator in this package is intentionally strict and mirrors protocol
 * 0.1's public contract; published schema artifacts can replace it in a
 * deployment-specific composition root.
 */
export interface ProtocolValidator {
  begin(value: unknown): BeginRunRequest;
  submit(value: unknown): SubmitBatchRequest;
  complete(value: unknown): CompleteRunRequest;
}

export type ProducerServiceErrorCode =
  | "unauthorized"
  | "unauthorized_stream"
  | "unauthorized_producer"
  | "credential_expired"
  | "rate_limited"
  | "body_too_large"
  | "unsupported_media_type"
  | "invalid_json"
  | "schema_validation_failed"
  | "secret_field_rejected"
  | "secret_bearing_evidence_rejected"
  | "personal_data_rejected"
  | "batch_limit_exceeded"
  | "evidence_excerpt_too_large"
  | "evidence_metadata_too_large"
  | "invalid_input"
  | "run_not_found"
  | "batch_not_found"
  | "run_id_conflict"
  | "batch_id_conflict"
  | "batch_sequence_not_increasing"
  | "idempotency_payload_conflict"
  | "duplicate_finding"
  | "duplicate_evidence"
  | "unresolved_evidence_ref"
  | "completion_before_start"
  | "invalid_scope_stats"
  | "completion_counts_do_not_reconcile"
  | "terminal_run_immutable"
  | "storage_error";

export class ProducerServiceError extends Error {
  readonly code: ProducerServiceErrorCode;
  readonly status: number;
  readonly retry_after_seconds: number | null;
  readonly details: Record<string, unknown>;

  constructor(
    code: ProducerServiceErrorCode,
    message: string = code,
    options: { status?: number; retry_after_seconds?: number | null; details?: Record<string, unknown> } = {},
  ) {
    super(message);
    this.name = "ProducerServiceError";
    this.code = code;
    this.status = options.status ?? statusForProducerError(code);
    this.retry_after_seconds = options.retry_after_seconds ?? null;
    this.details = options.details ?? {};
  }
}

export function statusForProducerError(code: ProducerServiceErrorCode | PersistenceErrorCode): number {
  if (code === "unauthorized" || code === "credential_expired") return 401;
  if (code === "unauthorized_stream" || code === "unauthorized_producer") return 403;
  if (code === "run_not_found" || code === "batch_not_found") return 404;
  if (code === "body_too_large" || code === "batch_limit_exceeded" || code === "evidence_excerpt_too_large" || code === "evidence_metadata_too_large") return 413;
  if (code === "idempotency_payload_conflict" || code === "run_id_conflict" || code === "batch_id_conflict" || code === "batch_sequence_not_increasing" || code === "duplicate_finding" || code === "duplicate_evidence" || code === "terminal_run_immutable" || code === "completion_counts_do_not_reconcile") return 409;
  if (code === "storage_error") return 503;
  if (code === "rate_limited") return 429;
  if (code === "unsupported_media_type") return 415;
  if (code === "secret_field_rejected" || code === "secret_bearing_evidence_rejected" || code === "personal_data_rejected" || code === "schema_validation_failed" || code === "invalid_json") return 422;
  return 400;
}
