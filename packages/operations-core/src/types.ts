/** JSON values accepted by operation metadata and audit details. */
export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export type JsonObject = { [key: string]: JsonValue };

/** Entity names are intentionally explicit: a policy cannot silently expand. */
export type RetentionEntity =
  | "run"
  | "batch"
  | "finding"
  | "evidence"
  | "outbox_event"
  | "delivery"
  | "delivery_attempt"
  | "liveness_incident"
  /** External/object-storage content whose lifecycle is explicitly managed. */
  | "managed_artifact";

export const RETENTION_ENTITIES: readonly RetentionEntity[] = [
  "run",
  "batch",
  "finding",
  "evidence",
  "outbox_event",
  "delivery",
  "delivery_attempt",
  "liveness_incident",
  "managed_artifact",
];

/** Accepted protocol and delivery records are history, not deletion targets. */
export const PROTECTED_RETENTION_ENTITIES: readonly RetentionEntity[] = RETENTION_ENTITIES.filter(
  (entity): entity is RetentionEntity => entity !== "managed_artifact",
);
export const DELETABLE_RETENTION_ENTITIES = ["managed_artifact"] as const;
export type DeletableRetentionEntity = (typeof DELETABLE_RETENTION_ENTITIES)[number];
export const MAX_RETENTION_CANDIDATES = 500 as const;
export const MAX_AUDIT_EXPORT_RECORDS = 1_000 as const;
export const MAX_AUDIT_EXPORT_BYTES = 1_048_576 as const;

export type AuditRecordType = RetentionEntity | "retention" | "operator_action";

/** A database adapter exposes metadata, never raw protocol payloads, to this package. */
export interface RetentionRecord {
  readonly tenantId: string;
  readonly entity: RetentionEntity;
  readonly id: string;
  readonly runId: string | null;
  readonly streamId: string | null;
  readonly createdAt: string;
  /** Terminal time is required for records that can still be running. */
  readonly terminalAt: string | null;
  readonly status: string | null;
  /** A legal hold is a fail-closed deletion veto. */
  readonly legalHold: boolean;
  /** Optional policy-specific retention override, represented as an absolute time. */
  readonly retainUntil: string | null;
  /** Optional non-sensitive operational labels for the plan preview. */
  readonly metadata?: JsonObject;
}

export interface RetentionRule {
  /** Age in seconds after terminalAt (or createdAt for non-terminal entities). */
  readonly ageSeconds: number;
  /** Entities that are not terminal are never deleted when this is true. */
  readonly requireTerminal: boolean;
}

export interface RetentionPolicy {
  readonly policyVersion: string;
  readonly defaultRule: RetentionRule;
  readonly rules?: Partial<Record<RetentionEntity, RetentionRule>>;
}

export interface RetentionScope {
  /** Tenant is mandatory; operations never run across tenants. */
  readonly tenantId: string;
  readonly runIds?: readonly string[];
  readonly streamIds?: readonly string[];
  readonly entities?: readonly RetentionEntity[];
}

export interface RetentionPlanRequest {
  readonly now: string;
  readonly scope: RetentionScope;
  readonly policy: RetentionPolicy;
  readonly records: readonly RetentionRecord[];
}

export type RetentionSkipReason =
  | "tenant_mismatch"
  | "outside_scope"
  | "unknown_entity"
  | "invalid_record"
  | "protected_entity"
  | "legal_hold"
  | "not_terminal"
  | "not_expired"
  | "missing_retention_time";

export interface RetentionDeletionCandidate {
  readonly tenantId: string;
  readonly entity: DeletableRetentionEntity;
  readonly id: string;
  readonly runId: string | null;
  readonly streamId: string | null;
  readonly eligibleAt: string;
  readonly reason: "expired";
}

export interface RetentionSkip {
  readonly tenantId: string;
  readonly entity: string;
  readonly id: string;
  readonly reason: RetentionSkipReason;
}

export interface RetentionPlan {
  readonly schemaVersion: "agent-feed.retention-plan.v1";
  readonly planId: string;
  readonly policyVersion: string;
  readonly generatedAt: string;
  readonly scope: RetentionScope;
  readonly candidates: readonly RetentionDeletionCandidate[];
  readonly skipped: readonly RetentionSkip[];
}

export interface RetentionDeletionResult {
  readonly entity: RetentionEntity;
  readonly id: string;
  readonly deleted: boolean;
}

/**
 * Store boundary for an operator worker. Implementations must enforce the
 * tenant and run predicates in the same transaction as deletion. The core
 * package never constructs SQL and never mutates consumer state itself.
 */
export interface RetentionStore {
  listRecords(scope: RetentionScope): Promise<readonly RetentionRecord[]>;
  deleteRecords(input: {
    tenantId: string;
    planId: string;
    candidates: readonly RetentionDeletionCandidate[];
  }): Promise<readonly RetentionDeletionResult[]>;
}

export interface RetentionExecution {
  readonly schemaVersion: "agent-feed.retention-execution.v1";
  readonly planId: string;
  readonly dryRun: boolean;
  readonly attempted: number;
  readonly deleted: number;
  readonly results: readonly RetentionDeletionResult[];
}

export interface AuditRecord {
  readonly tenantId: string;
  readonly recordType: AuditRecordType;
  readonly recordId: string;
  readonly runId: string | null;
  readonly streamId: string | null;
  readonly occurredAt: string;
  readonly action: string;
  readonly status: string | null;
  readonly traceId: string | null;
  readonly payloadHash: string | null;
  /** Metadata only. Raw findings/evidence are deliberately not export inputs. */
  readonly details?: JsonObject;
}

export interface AuditExportScope {
  readonly tenantId: string;
  readonly runIds?: readonly string[];
  readonly streamIds?: readonly string[];
  readonly recordTypes?: readonly AuditRecordType[];
  readonly from?: string;
  readonly to?: string;
}

export interface AuditExportRequest {
  readonly scope: AuditExportScope;
  readonly records: readonly AuditRecord[];
}

export interface AuditExport {
  readonly schemaVersion: "agent-feed.audit-export.v1";
  readonly format: "ndjson";
  readonly tenantId: string;
  readonly recordCount: number;
  readonly firstOccurredAt: string | null;
  readonly lastOccurredAt: string | null;
  readonly contentSha256: string;
  /** Canonical NDJSON; every non-empty line is one stable audit record. */
  readonly content: string;
}
