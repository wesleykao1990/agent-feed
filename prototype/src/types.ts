export type RunStatus = "running" | "completed" | "partial" | "failed" | "cancelled";
export type TerminalRunStatus = Exclude<RunStatus, "running">;

export interface Scope {
  sourceIds: string[];
  subjects: string[];
  queries: string[];
}

export interface RunRecord {
  runId: string;
  streamId: string;
  producerId: string;
  beginIdempotencyKey: string;
  beginPayloadHash: string;
  completeIdempotencyKey: string | null;
  completePayloadHash: string | null;
  status: RunStatus;
  startedAt: string;
  completedAt: string | null;
  expectedScope: Scope;
  actualScope: Scope | null;
  findings: Finding[];
  evidence: SubmittedEvidence[];
  stats: {
    sourcesAttempted: number;
    sourcesSucceeded: number;
    batchesSubmitted: number;
  };
  errorSummary: string | null;
}

export interface Finding {
  findingId: string;
  findingType: string;
  title: string;
  summary: string;
  subjects: Array<{ type: string; id: string | null; name: string | null }>;
  evidenceRefs: string[];
  securityFlags: string[];
  attributes: Record<string, unknown>;
  wirePayload?: Record<string, unknown>;
}

export interface SubmittedEvidence {
  evidenceId: string;
  kind: string;
  sourceUri: string | null;
  excerpt: string | null;
  securityFlags?: string[];
  handling?: {
    containsPersonalData: boolean;
    containsSecrets: boolean;
    redistributionRestricted: boolean;
  };
  wirePayload?: Record<string, unknown>;
}

export interface StreamExpectation {
  streamId: string;
  expectedCadenceSeconds: number;
  graceSeconds: number;
  enabled: boolean;
  expectedSourceIds: string[];
  owner: string;
  lastTerminalRunAt: string | null;
  lastTerminalStatus: TerminalRunStatus | null;
  lastTerminalRunId: string | null;
  lastTerminalFindingCount: number | null;
  nextDueAt: string | null;
}

export type LivenessStatus = "healthy" | "due" | "overdue" | "degraded" | "disabled" | "never_seen";
export type LivenessObservation =
  | "zero_findings"
  | "findings"
  | "partial"
  | "failed"
  | "cancelled"
  | "absent_run";
export type LivenessIncidentType = "missed_run";
export type LivenessIncidentStatus = "open" | "acknowledged" | "resolved";

/**
 * Append-only-shaped liveness record. A recovery changes only status and
 * resolvedAt; the incident is never removed from the in-memory ledger.
 */
export interface LivenessIncident {
  incidentId: string;
  streamId: string;
  incidentType: LivenessIncidentType;
  status: LivenessIncidentStatus;
  detectedAt: string;
  expectedBy: string | null;
  resolvedAt: string | null;
  details: Record<string, unknown>;
}

export interface LivenessResult {
  streamId: string;
  status: LivenessStatus;
  observation: LivenessObservation;
  nextDueAt: string | null;
  affectedSourceIds: string[];
  lastTerminalStatus: TerminalRunStatus | null;
  lastTerminalRunAt: string | null;
  lastTerminalRunId: string | null;
  lastTerminalFindingCount: number | null;
  incident: LivenessIncident | null;
}

export type DeliveryEventType =
  | "run.started"
  | "finding.submitted"
  | "run.completed"
  | "run.partial"
  | "run.failed";

export interface DeliveryEvent {
  protocolVersion: "0.1";
  eventId: string;
  eventType: DeliveryEventType;
  streamId: string;
  runId: string;
  findingId: string | null;
  occurredAt: string;
  attempt: number;
  payload: Record<string, unknown>;
}

/**
 * The event itself remains schema-shaped. Signature metadata is carried next
 * to the immutable wire body so `rawBody` can be verified exactly as sent.
 */
export interface SignedDeliveryEvent extends DeliveryEvent {
  timestampSeconds: number;
  signature: string;
  rawBody: string;
  /** Alias for integrations that call the signed wire body `body`. */
  body: string;
  keyId?: string;
}
