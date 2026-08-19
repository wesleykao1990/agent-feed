import type { QueryResult, QueryResultRow } from "pg";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export type JsonObject = { [key: string]: JsonValue };

export type ArtifactAction = "delete" | "tombstone";
export type ArtifactClass = "recovery" | "submitted_artifact" | "export" | "other";
export type ManagedArtifactStatus = "active" | "retained" | "deleted" | "tombstoned";
export type RetentionJobStatus = "planned" | "executing" | "completed" | "failed";
export type RetentionItemStatus = "planned" | "in_progress" | "deleted" | "tombstoned" | "skipped" | "failed";
export type ExternalArtifactOutcome = "deleted" | "tombstoned" | "already_absent" | "failed";

export interface PgQueryResultRow extends QueryResultRow {
  [key: string]: unknown;
}

export interface SqlExecutor {
  query<R extends QueryResultRow = PgQueryResultRow>(text: string, values?: unknown[]): Promise<QueryResult<R>>;
}

export interface SqlPool extends SqlExecutor {
  connect(): Promise<SqlClient>;
}

export interface SqlClient extends SqlExecutor {
  release(error?: Error): void;
}

export interface RetentionPolicyInput {
  tenantId: string;
  policyKey: string;
  artifactClass: ArtifactClass;
  action: ArtifactAction;
  retentionSeconds: number;
  enabled?: boolean;
}

export interface RetentionPolicy extends RetentionPolicyInput {
  id: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ManagedArtifactInput {
  tenantId: string;
  artifactKey: string;
  storageRef: string;
  artifactClass: ArtifactClass;
  createdAt: string;
  expiresAt?: string | null;
  contentHash?: string | null;
  sourceRunId?: string | null;
  sourceEventId?: string | null;
  legalHold?: boolean;
  metadata?: JsonObject;
}

export interface ManagedArtifact extends ManagedArtifactInput {
  id: string;
  status: ManagedArtifactStatus;
  expiresAt: string | null;
  contentHash: string | null;
  sourceRunId: string | null;
  sourceEventId: string | null;
  legalHold: boolean;
  metadata: JsonObject;
  registeredAt: string;
  deletedAt: string | null;
  tombstonedAt: string | null;
}

export interface RetentionPlanRequest {
  tenantId: string;
  idempotencyKey: string;
  policyKey: string;
  asOf: string;
  requestedBy: string;
  maxItems?: number;
}

export interface RetentionPlanItem {
  id: string;
  artifactId: string;
  artifactKey: string;
  storageRef: string;
  artifactClass: ArtifactClass;
  action: ArtifactAction;
  status: RetentionItemStatus;
  expiresAt: string;
}

export interface RetentionJob {
  id: string;
  tenantId: string;
  idempotencyKey: string;
  policyKey: string;
  action: ArtifactAction;
  asOf: string;
  requestedBy: string;
  requestHash: string;
  maxItems: number;
  status: RetentionJobStatus;
  candidateCount: number;
  completedCount: number;
  failedCount: number;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  items: RetentionPlanItem[];
}

export interface RetentionExecutionRequest {
  tenantId: string;
  jobId: string;
  requestedBy: string;
  confirmationToken: string;
}

export interface ExternalArtifactRequest {
  tenantId: string;
  artifactId: string;
  artifactKey: string;
  storageRef: string;
  action: ArtifactAction;
  jobId: string;
  itemId: string;
  /** Stable operation identity for an idempotent external adapter call. */
  operationId: string;
  /** Passed only to the injected adapter; never persisted or logged. */
  confirmationToken: string;
}

export interface ExternalArtifactResult {
  outcome: ExternalArtifactOutcome;
  externalReference?: string | null;
  errorCode?: string | null;
}

export interface ExternalArtifactAdapter {
  apply(request: ExternalArtifactRequest): Promise<ExternalArtifactResult>;
}

export interface RetentionExecutionResult {
  job: RetentionJob;
  attempted: number;
  completed: number;
  failed: number;
}

export interface AuditEvent {
  id: string;
  tenantId: string;
  jobId: string | null;
  artifactId: string | null;
  eventType: string;
  actor: string;
  details: JsonObject;
  occurredAt: string;
}

export interface AuditQuery {
  tenantId: string;
  from?: string;
  to?: string;
  limit?: number;
}

export type AuditSourceType =
  | "protocol.run"
  | "protocol.batch"
  | "protocol.finding"
  | "protocol.evidence"
  | "delivery.outbox"
  | "delivery.delivery"
  | "delivery.attempt"
  | "delivery.acknowledgement"
  | "delivery.acknowledgement_command"
  | "delivery.replay"
  | "operations.audit";

export interface AuditSourceRecord {
  sourceType: AuditSourceType;
  sourceId: string;
  tenantId: string;
  occurredAt: string;
  metadata: JsonObject;
}

export interface AuditSourceQuery extends AuditQuery {}

export interface OperationsSnapshot {
  tenantId: string;
  asOf: string;
  managedArtifacts: number;
  retentionCandidates: number;
  artifactsDeleted: number;
  artifactsTombstoned: number;
  plannedJobs: number;
  executingJobs: number;
  failedJobs: number;
  pendingDeliveries: number;
  oldestPendingAgeSeconds: number | null;
  /** Null until stream expectations acquire a tenant-scoped relation. */
  liveness: LivenessSnapshot | null;
}

export interface LivenessSnapshot {
  tenantScope: "available";
  overdueStreams: number;
  degradedStreams: number;
  neverSeenStreams: number;
}

export interface OperationsRepositoryOptions {
  maxPlanItems?: number;
  maxAuditRows?: number;
}
