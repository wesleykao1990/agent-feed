import type { DashboardMetricKey, DashboardSnapshotState } from "./contracts.ts";

export type DashboardTone = "good" | "warning" | "critical" | "neutral";

export interface DashboardMetricCard {
  readonly key: DashboardMetricKey;
  readonly label: string;
  readonly value: string;
  readonly tone: DashboardTone;
  readonly help: string;
}

export interface DashboardView {
  readonly kind: "ready";
  readonly statusLabel: string;
  readonly statusTone: DashboardTone;
  readonly generatedAt: string;
  readonly ageLabel: string;
  readonly stale: boolean;
  readonly cards: readonly DashboardMetricCard[];
}

const LABELS: Readonly<Record<DashboardMetricKey, { label: string; help: string; unit: string }>> = {
  pending_events: { label: "Pending events", help: "Events waiting for delivery.", unit: "count" },
  oldest_pending_age_seconds: { label: "Oldest pending", help: "Age of the oldest pending event.", unit: "seconds" },
  active_leases: { label: "Active leases", help: "Delivery leases currently held by workers.", unit: "count" },
  expired_leases: { label: "Expired leases", help: "Leases that have expired and need recovery.", unit: "count" },
  dead_letters_total: { label: "Dead letters", help: "Dead letters retained by the delivery system.", unit: "count" },
  delivery_attempts_total: { label: "Delivery attempts", help: "Delivery attempts recorded by the system.", unit: "count" },
  overdue_streams: { label: "Overdue streams", help: "Streams exceeding their delivery objective.", unit: "count" },
  retention_eligible_artifacts: { label: "Retention-eligible artifacts", help: "Artifacts eligible for the configured retention policy.", unit: "count" },
};

const CARD_ORDER: readonly DashboardMetricKey[] = [
  "pending_events",
  "oldest_pending_age_seconds",
  "active_leases",
  "expired_leases",
  "dead_letters_total",
  "delivery_attempts_total",
  "overdue_streams",
  "retention_eligible_artifacts",
];

function toneFor(key: DashboardMetricKey, value: number): DashboardTone {
  if (key === "oldest_pending_age_seconds") return value >= 900 ? "critical" : value >= 300 ? "warning" : "good";
  if (key === "expired_leases") return value >= 10 ? "critical" : value > 0 ? "warning" : "good";
  if (key === "dead_letters_total") return value >= 100 ? "critical" : value > 0 ? "warning" : "good";
  if (key === "overdue_streams") return value >= 5 ? "critical" : value > 0 ? "warning" : "good";
  if (key === "pending_events") return value > 10_000 ? "critical" : value > 0 ? "warning" : "good";
  return "neutral";
}

function formatValue(value: number, unit: string): string {
  if (unit === "seconds") return `${value.toFixed(value >= 100 ? 0 : 2)} s`;
  return Math.round(value).toLocaleString("en-US");
}

function overallTone(state: Extract<DashboardSnapshotState, { kind: "ready" }>): DashboardTone {
  if (state.stale) return "warning";
  const tones = CARD_ORDER.map((key) => toneFor(key, state.snapshot.metrics[key]));
  if (tones.includes("critical")) return "critical";
  if (tones.includes("warning")) return "warning";
  return "good";
}

export function createDashboardView(state: DashboardSnapshotState): DashboardView | null {
  if (state.kind !== "ready") return null;
  const tone = overallTone(state);
  return {
    kind: "ready",
    statusTone: tone,
    statusLabel: tone === "good" ? "Healthy" : tone === "warning" ? "Needs attention" : "Critical signals",
    generatedAt: state.snapshot.generatedAt,
    ageLabel: state.ageSeconds < 1 ? "just now" : `${Math.round(state.ageSeconds)} seconds ago`,
    stale: state.stale,
    cards: CARD_ORDER.map((key) => {
      const metadata = LABELS[key];
      return {
        key,
        label: metadata.label,
        help: metadata.help,
        value: formatValue(state.snapshot.metrics[key], metadata.unit),
        tone: toneFor(key, state.snapshot.metrics[key]),
      };
    }),
  };
}

export { CARD_ORDER, LABELS };
