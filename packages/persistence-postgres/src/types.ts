import type { Pool, PoolClient } from "pg";

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
  /** Optional deterministic ID for trusted callers and tests; the wire contract does not require it. */
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

export interface StreamExpectationInput {
  stream_id: string;
  expected_cadence_seconds: number;
  grace_seconds: number;
  enabled: boolean;
  expected_scope: {
    source_ids: string[];
    subjects: string[];
  };
  owner: string;
  notes?: string;
}

export interface StreamExpectation extends StreamExpectationInput {
  notes: string;
  last_terminal_run_at: string | null;
  last_terminal_status: TerminalRunStatus | null;
  next_due_at: string | null;
  created_at: string;
  updated_at: string;
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

export interface ListRunsOptions {
  stream_id?: string;
  status?: RunStatus;
  limit?: number;
  offset?: number;
}

export interface LivenessResult {
  stream_id: string;
  liveness_status: "healthy" | "due" | "overdue" | "degraded" | "disabled" | "never_seen";
  expected_by: string | null;
}

/** M7 occurrence sidecar types.  These are deliberately separate from the
 * protocol 0.1 run envelope and therefore can evolve without changing wire
 * compatibility. */
export type ScheduleKind = "interval" | "cron";
export type OccurrenceMatchingMode = "explicit" | "windowed" | "legacy";
export type MisfirePolicy = "mark_missed" | "fire_latest" | "catch_up";
export type OverlapPolicy = "allow" | "skip" | "fail_closed";
export type OccurrenceTriggerKind =
  | "scheduled"
  | "legacy"
  | "manual"
  | "test"
  | "retry"
  | "replay"
  | "backfill"
  | "event"
  | "unknown";

export interface ScheduleExpectedScope {
  source_ids: string[];
  subjects: string[];
  queries?: string[];
  metadata?: JsonObject;
}

export interface ScheduleExpectationVersionInput {
  tenant_id?: string;
  schedule_key: string;
  /** Stream identity is immutable and must match every linked run. */
  stream_id: string;
  version?: number;
  schedule_kind: ScheduleKind;
  interval_seconds?: number | null;
  cron_expression?: string | null;
  timezone: string;
  /** Immutable UTC anchor used by an external calculator; this repository does not drift it from run completion. */
  anchor_at: string;
  matching_mode: OccurrenceMatchingMode;
  misfire_policy: MisfirePolicy;
  overlap_policy: OverlapPolicy;
  grace_seconds: number;
  enabled?: boolean;
  expected_scope: ScheduleExpectedScope | JsonObject;
  owner: string;
  notes?: string;
  calculator_version?: string;
  tzdata_version?: string;
  calculator_provenance?: JsonObject;
  tzdata_provenance?: JsonObject;
  baseline_next_due_at?: string | null;
}

export interface ScheduleExpectationVersion extends Omit<ScheduleExpectationVersionInput, "tenant_id" | "version" | "enabled" | "notes" | "calculator_version" | "tzdata_version" | "calculator_provenance" | "tzdata_provenance" | "baseline_next_due_at"> {
  id: string;
  tenant_id: string;
  stream_id: string;
  version: number;
  enabled: boolean;
  notes: string;
  calculator_version: string;
  tzdata_version: string;
  calculator_provenance: JsonObject;
  tzdata_provenance: JsonObject;
  baseline_next_due_at: string | null;
  created_at: string;
}

export interface ExpectedOccurrenceInput {
  tenant_id?: string;
  schedule_version_id?: string;
  schedule_key?: string;
  version?: number;
  occurrence_key: string;
  ordinal: number;
  expected_at: string;
  window_start: string;
  window_end: string;
  metadata?: JsonObject;
}

export interface ExpectedOccurrence extends Omit<ExpectedOccurrenceInput, "tenant_id" | "schedule_version_id" | "schedule_key" | "version" | "metadata"> {
  id: string;
  tenant_id: string;
  schedule_version_id: string;
  schedule_key: string;
  version: number;
  metadata: JsonObject;
  created_at: string;
}

export interface RunOccurrenceLinkInput {
  tenant_id?: string;
  run_id: string;
  schedule_version_id?: string;
  schedule_key?: string;
  version?: number;
  occurrence_id?: string;
  occurrence_key?: string;
  matched_at?: string;
  metadata?: JsonObject;
}

export interface TrustedRunTriggerContextInput {
  tenant_id?: string;
  /** Public producer-visible wire run ID; repository resolves it tenant-safely. */
  run_id: string;
  trigger_kind: OccurrenceTriggerKind;
  schedule_version_id?: string;
  schedule_key?: string;
  version?: number;
  trusted_source: string;
  metadata?: JsonObject;
}

export interface TrustedRunTriggerContext {
  id: string;
  tenant_id: string;
  run_id: string;
  trigger_kind: OccurrenceTriggerKind;
  schedule_version_id: string | null;
  schedule_key: string | null;
  version: number | null;
  trusted_source: string;
  metadata: JsonObject;
  created_at: string;
}

export interface RunOccurrenceLink {
  id: string;
  tenant_id: string;
  schedule_version_id: string;
  schedule_key: string;
  version: number;
  occurrence_id: string;
  occurrence_key: string;
  /** Producer-visible wire run ID.  The database stores and constrains the internal UUID alongside it. */
  run_id: string;
  trigger_kind: OccurrenceTriggerKind;
  matching_mode: OccurrenceMatchingMode;
  matched_at: string;
  metadata: JsonObject;
  created_at: string;
}

export type OccurrenceLivenessStatus =
  | "upcoming"
  | "due"
  | "absent"
  | "invoked_running"
  | "satisfied"
  | "invoked_partial"
  | "invoked_failed"
  | "invoked_cancelled"
  | "disabled"
  | "suppressed";

export interface OccurrenceLiveness {
  tenant_id: string;
  schedule_version_id: string;
  schedule_key: string;
  version: number;
  schedule_enabled: boolean;
  occurrence_id: string;
  occurrence_key: string;
  ordinal: number;
  expected_at: string;
  window_start: string;
  window_end: string;
  status: OccurrenceLivenessStatus;
  run_id: string | null;
  run_status: RunStatus | null;
  trigger_kind: OccurrenceTriggerKind | null;
  matching_mode: OccurrenceMatchingMode | null;
  matched_at: string | null;
  metadata: JsonObject;
}

export interface OccurrenceLivenessOptions {
  tenant_id: string;
  schedule_version_id?: string;
  schedule_key?: string;
  version?: number;
  now?: string | Date;
  include_disabled?: boolean;
  limit?: number;
  offset?: number;
}

export interface MaterializeScheduleOccurrencesInput {
  tenant_id?: string;
  schedule_version_id?: string;
  schedule_key?: string;
  version?: number;
  from: string;
  to: string;
  limit?: number;
}

export interface ScheduleExpectationListOptions {
  tenant_id: string;
  schedule_key?: string;
  enabled?: boolean;
  limit?: number;
  offset?: number;
}

export interface ExpectedOccurrenceListOptions {
  tenant_id: string;
  schedule_version_id?: string;
  schedule_key?: string;
  version?: number;
  from?: string | Date;
  to?: string | Date;
  limit?: number;
  offset?: number;
}

export interface MigrationQuarantineRecord {
  id: string;
  tenant_id: string;
  stream_id: string;
  reason: string;
  details: JsonObject;
  detected_at: string;
}

export type PgPool = Pool;
export type PgTransactionClient = PoolClient;
