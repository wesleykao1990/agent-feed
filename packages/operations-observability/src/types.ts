export const LIVENESS_STATES = ["healthy", "due", "overdue", "degraded", "disabled", "never_seen"] as const;
export type LivenessState = (typeof LIVENESS_STATES)[number];

export const ATTEMPT_OUTCOMES = ["delivered", "retry", "failed", "dead_letter"] as const;
export type AttemptOutcome = (typeof ATTEMPT_OUTCOMES)[number];

export const FAILURE_REASONS = [
  "authentication",
  "timeout",
  "transport",
  "server",
  "client",
  "signature",
  "unknown",
] as const;
export type FailureReason = (typeof FAILURE_REASONS)[number];

export interface DeliveryMetricInput {
  /** ISO timestamp for the database snapshot, not a caller-provided event timestamp. */
  readonly observedAt: string;
  readonly backlog: {
    readonly pendingEvents: number;
    readonly oldestPendingAgeSeconds: number | null;
    readonly activeLeases: number;
    readonly expiredLeases: number;
  };
  readonly attempts: {
    readonly total: number;
    readonly byOutcome?: Partial<Record<AttemptOutcome, number>>;
    readonly failuresTotal?: number;
    readonly failuresByReason?: Partial<Record<FailureReason, number>>;
    readonly retriesTotal?: number;
    readonly acknowledgementsTotal?: number;
    readonly deadLettersTotal?: number;
  };
  readonly liveness: {
    readonly expectedStreams: number;
    readonly byState: Partial<Record<LivenessState, number>>;
  };
  readonly storage: {
    readonly outboxRows: number;
    readonly deliveryRows: number;
    readonly attemptRows: number;
    readonly totalBytes: number;
    /** Managed external artifacts only; immutable protocol/delivery rows are not deletion candidates. */
    readonly managedArtifactRows: number;
    readonly managedArtifactBytes: number;
  };
  readonly cost?: {
    readonly egressBytesTotal?: number;
    readonly estimatedCostUsdTotal?: number;
  };
}

export interface MetricLimits {
  /** Maximum value retained for count-like metrics. */
  readonly maxCount?: number;
  /** Maximum age represented by the oldest-pending gauge. */
  readonly maxAgeSeconds?: number;
  /** Maximum bytes represented by storage and egress metrics. */
  readonly maxBytes?: number;
  /** Maximum estimated cumulative cost represented by the cost metric. */
  readonly maxCostUsd?: number;
}

export type MetricType = "counter" | "gauge";

export interface MetricSample {
  readonly labels: Readonly<Record<string, string>>;
  readonly value: number;
}

export interface MetricFamily {
  readonly name: string;
  readonly type: MetricType;
  readonly help: string;
  readonly samples: readonly MetricSample[];
}

export interface MetricSnapshot {
  readonly protocolVersion: "0.1";
  readonly observedAt: string;
  readonly families: readonly MetricFamily[];
}

/** Read-only composition boundary implemented by a persistence adapter. */
export interface MetricsSampleProvider {
  readMetricsSample(): Promise<DeliveryMetricInput>;
}

export interface PrometheusOptions {
  /** Include one timestamp column using `timestampMs` or the snapshot time. */
  readonly includeTimestamp?: boolean;
  readonly timestampMs?: number;
}
