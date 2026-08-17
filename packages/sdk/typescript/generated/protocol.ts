/*
 * GENERATED FILE — DO NOT EDIT.
 * Source of truth: packages/schema/contracts/*.schema.json
 * Generator: scripts/generate_protocol_types.py
 * Wire property names are intentionally preserved as snake_case.
 */

export type ProtocolVersion = "0.1";

export interface BeginRunRequest {
  protocol_version: "0.1";
  idempotency_key: string;
  stream_id: string;
  producer: BeginRunRequestProducer;
  task: BeginRunRequestTask;
  expected_scope: BeginRunRequestExpectedScope;
  started_at: string;
  parent_run_id: string | null;
  metadata: Record<string, unknown>;
}

export interface CompleteRunRequest {
  protocol_version: "0.1";
  run_id: string;
  idempotency_key: string;
  status: "completed" | "partial" | "failed" | "cancelled";
  completed_at: string;
  actual_scope: CompleteRunRequestActualScope;
  stats: CompleteRunRequestStats;
  errors: Array<CompleteRunRequestErrorsItem>;
  metadata: Record<string, unknown>;
}

export interface DeliveryEvent {
  protocol_version: "0.1";
  event_id: string;
  event_type: "run.started" | "finding.submitted" | "run.completed" | "run.partial" | "run.failed";
  stream_id: string;
  run_id: string;
  finding_id: string | null;
  occurred_at: string;
  attempt: number;
  payload: Record<string, unknown>;
}

export interface SubmittedEvidence {
  evidence_id: string;
  kind: "web" | "document" | "email" | "api" | "social_post" | "database" | "human_observation" | "file" | "other";
  source: SubmittedEvidenceSource;
  captured_at: string;
  published_at: string | null;
  locator: null | SubmittedEvidenceLocator;
  excerpt: string | null;
  content_hash: string | null;
  artifact: SubmittedEvidenceArtifact;
  handling: SubmittedEvidenceHandling;
  metadata: Record<string, unknown>;
}

export interface Finding {
  finding_id: string;
  finding_type: string;
  title: string;
  summary: string;
  subjects: Array<FindingSubjectsItem>;
  effective_time: FindingEffectiveTime;
  assessment: FindingAssessment;
  evidence_refs: Array<string>;
  producer_dedupe_key: string | null;
  routing_tags: Array<string>;
  attributes: Record<string, unknown>;
  security_flags: Array<string>;
}

export interface RunBundle {
  protocol_version: "0.1";
  begin: BeginRunRequest;
  batches: Array<SubmitBatchRequest>;
  complete: CompleteRunRequest;
  run_id: string;
}

export interface RunEnvelope {
  protocol_version: "0.1";
  run_id: string;
  stream_id: string;
  producer: RunEnvelopeProducer;
  task: RunEnvelopeTask;
  started_at: string;
  completed_at: string | null;
  status: "running" | "completed" | "partial" | "failed" | "cancelled";
  expected_scope: RunEnvelopeScope;
  actual_scope: RunEnvelopeScope | null;
  stats: RunEnvelopeStats;
  parent_run_id: string | null;
  error_summary: string | null;
  metadata: Record<string, unknown>;
}

export interface StreamExpectation {
  stream_id: string;
  expected_cadence_seconds: number;
  grace_seconds: number;
  enabled: boolean;
  expected_scope: StreamExpectationExpectedScope;
  last_terminal_run_at: string | null;
  next_due_at: string | null;
  evaluated_at: string;
  liveness_status: "healthy" | "due" | "overdue" | "degraded" | "disabled" | "never_seen";
  owner: string;
  notes: string;
}

export interface SubmitBatchRequest {
  protocol_version: "0.1";
  run_id: string;
  batch_id: string;
  idempotency_key: string;
  sequence_number: number;
  submitted_at: string;
  findings: Array<Finding>;
  evidence: Array<SubmittedEvidence>;
  metadata: Record<string, unknown>;
}

export interface BeginRunRequestProducer {
  producer_id: string;
  type: "chatgpt" | "claude" | "codex" | "custom_agent" | "human" | "automation";
  name: string;
  version: string | null;
}

export interface BeginRunRequestTask {
  task_type: string;
  definition_id: string | null;
  definition_version: string | null;
}

export interface BeginRunRequestExpectedScope {
  source_ids: Array<string>;
  subjects: Array<string>;
  queries: Array<string>;
  metadata: Record<string, unknown>;
}

export interface CompleteRunRequestActualScope {
  source_ids: Array<string>;
  subjects: Array<string>;
  queries: Array<string>;
  metadata: Record<string, unknown>;
}

export interface CompleteRunRequestStats {
  sources_attempted: number;
  sources_succeeded: number;
  findings_submitted: number;
  evidence_submitted: number;
  batches_submitted: number;
}

export interface CompleteRunRequestErrorsItem {
  code: string;
  message: string;
  source_id: string | null;
  retryable: boolean;
}

export interface SubmittedEvidenceSource {
  uri: string | null;
  title: string | null;
  publisher: string | null;
  source_id: string | null;
}

export interface SubmittedEvidenceLocator {
  type: string;
  value: string;
  page: number | null;
}

export interface SubmittedEvidenceArtifact {
  uri: string | null;
  media_type: string | null;
  size_bytes: number | null;
}

export interface SubmittedEvidenceHandling {
  contains_personal_data: boolean;
  contains_secrets: boolean;
  redistribution_restricted: boolean;
}

export interface FindingSubjectsItem {
  type: string;
  id: string | null;
  name: string | null;
}

export interface FindingEffectiveTime {
  occurred_at: string | null;
  effective_from: string | null;
  effective_to: string | null;
}

export interface FindingAssessment {
  novelty: "new" | "known" | "uncertain";
  evidence_completeness: "complete" | "partial" | "lead_only";
  agent_confidence: number | null;
  source_authority_claim: "primary" | "official_secondary" | "third_party" | "unknown";
}

export interface RunEnvelopeScope {
  source_ids: Array<string>;
  subjects: Array<string>;
  queries: Array<string>;
  metadata: Record<string, unknown>;
}

export interface RunEnvelopeProducer {
  producer_id: string;
  type: "chatgpt" | "claude" | "codex" | "custom_agent" | "human" | "automation";
  name: string;
  version: string | null;
}

export interface RunEnvelopeTask {
  task_type: string;
  definition_id: string | null;
  definition_version: string | null;
}

export interface RunEnvelopeStats {
  sources_attempted: number;
  sources_succeeded: number;
  findings_submitted: number;
  evidence_submitted: number;
  batches_submitted: number;
}

export interface StreamExpectationExpectedScope {
  source_ids: Array<string>;
  subjects: Array<string>;
}

export type BeginRun = BeginRunRequest;
export type CompleteRun = CompleteRunRequest;
export type AgentFeedDeliveryEvent = DeliveryEvent;
export type Evidence = SubmittedEvidence;
export type SubmitBatch = SubmitBatchRequest;
