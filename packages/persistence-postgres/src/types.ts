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

export type PgPool = Pool;
export type PgTransactionClient = PoolClient;
