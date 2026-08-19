/**
 * The dashboard consumes this deliberately small, sanitized contract.  The
 * producer of the snapshot owns authentication, tenant scoping, aggregation,
 * and metric-label allowlisting; this package only validates and presents the
 * result.  It does not accept raw events, URLs, evidence, or credentials.
 */

export const DASHBOARD_SCHEMA_VERSION = 1 as const;

export type DashboardMetricKey =
  | "pending_events"
  | "oldest_pending_age_seconds"
  | "active_leases"
  | "expired_leases"
  | "dead_letters_total"
  | "delivery_attempts_total"
  | "overdue_streams"
  | "retention_eligible_artifacts";

export type DashboardMetricValues = Readonly<Record<DashboardMetricKey, number>>;

export interface DashboardSnapshot {
  readonly schemaVersion: typeof DASHBOARD_SCHEMA_VERSION;
  /** RFC 3339 timestamp produced by the metrics adapter. */
  readonly generatedAt: string;
  /** Maximum age at which this aggregate is considered fresh. */
  readonly freshnessWindowSeconds: number;
  readonly metrics: DashboardMetricValues;
}

export type DashboardSnapshotState =
  | {
      readonly kind: "ready";
      readonly snapshot: DashboardSnapshot;
      readonly stale: boolean;
      readonly ageSeconds: number;
    }
  | {
      readonly kind: "empty";
      readonly reason: "no_snapshot";
    }
  | {
      readonly kind: "error";
      readonly error: "snapshot_invalid" | "snapshot_unavailable";
    };

export interface DashboardSnapshotSource {
  /**
   * Return an untrusted boundary value.  The dashboard validates it before
   * rendering or returning it from the local API.
   */
  read(): Promise<unknown>;
}

export type DashboardClock = () => number;
