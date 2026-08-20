export const CONTROL_PLANE_SCHEMA_VERSION = "agent-feed.control-plane.v1" as const;

export const FAILURE_LAYERS = ["provider", "gateway", "execution", "validation", "delivery"] as const;
export type FailureLayer = (typeof FAILURE_LAYERS)[number];
export type ControlPlaneHealth = "healthy" | "degraded" | "critical" | "unknown";

export interface CountGroup<T extends string> {
  readonly total: number;
  readonly byState: Readonly<Record<T, number>>;
}

export type JobState = "draft" | "shadow" | "active" | "paused" | "retired";
export type OccurrenceState = "pending" | "absent" | "running" | "completed_zero" | "completed" | "partial" | "failed" | "cancelled";
export type RunState = "running" | "completed" | "partial" | "failed" | "cancelled";
export type AssessmentState = "passed" | "failed" | "inconclusive" | "unknown";
export type DeliveryState = "queued" | "leased" | "retry" | "acknowledged" | "dead_letter";

export interface FailureAggregate {
  readonly layer: FailureLayer;
  readonly count: number;
}

export interface ControlPlaneObservationWindow {
  readonly from: string;
  readonly to: string;
}

export interface ControlPlaneSnapshotInput {
  readonly schemaVersion?: string;
  readonly tenantId: string;
  readonly generatedAt: string;
  readonly freshnessWindowSeconds: number;
  readonly observationWindow: ControlPlaneObservationWindow;
  readonly jobs: CountGroup<JobState>;
  readonly occurrences: CountGroup<OccurrenceState>;
  readonly runs: CountGroup<RunState>;
  readonly assessments: CountGroup<AssessmentState>;
  readonly deliveries: CountGroup<DeliveryState>;
  readonly failures: readonly FailureAggregate[];
}

export interface ControlPlaneSnapshot extends Omit<ControlPlaneSnapshotInput, "schemaVersion" | "failures"> {
  readonly schemaVersion: typeof CONTROL_PLANE_SCHEMA_VERSION;
  readonly failures: Readonly<Record<FailureLayer, number>>;
  readonly health: ControlPlaneHealth;
}

export interface ControlPlaneSnapshotState {
  readonly snapshot: ControlPlaneSnapshot;
  readonly ageSeconds: number;
  readonly stale: boolean;
}

export class ControlPlaneContractError extends Error {
  readonly issues: readonly string[];
  constructor(issues: readonly string[]) {
    super(`control_plane_invalid:${issues.join(";")}`);
    this.name = "ControlPlaneContractError";
    this.issues = issues;
  }
}
