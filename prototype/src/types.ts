export type RunStatus = "running" | "completed" | "partial" | "failed" | "cancelled";

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
}

export interface SubmittedEvidence {
  evidenceId: string;
  kind: string;
  sourceUri: string | null;
  excerpt: string | null;
  securityFlags?: string[];
}

export interface StreamExpectation {
  streamId: string;
  expectedCadenceSeconds: number;
  graceSeconds: number;
  enabled: boolean;
  expectedSourceIds: string[];
  owner: string;
  lastTerminalRunAt: string | null;
  lastTerminalStatus: Exclude<RunStatus, "running"> | null;
  nextDueAt: string | null;
}

export interface LivenessResult {
  streamId: string;
  status: "healthy" | "due" | "overdue" | "degraded" | "disabled" | "never_seen";
  nextDueAt: string | null;
  affectedSourceIds: string[];
  lastTerminalStatus: Exclude<RunStatus, "running"> | null;
}

export interface DeliveryEvent {
  protocolVersion: "0.1";
  eventId: string;
  eventType: "finding.submitted" | "run.completed";
  streamId: string;
  runId: string;
  findingId: string | null;
  occurredAt: string;
  payload: Record<string, unknown>;
}
