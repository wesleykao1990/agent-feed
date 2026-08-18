import assert from "node:assert/strict";
import test from "node:test";
import { collectMetrics, findMetricFamily, LIVENESS_STATES, OBSERVABILITY_FAMILY_NAMES, toPrometheus } from "../src/index.ts";
import type { DeliveryMetricInput, MetricSnapshot } from "../src/index.ts";

interface MutableMetricSample {
  labels: Record<string, string>;
  value: number;
}

interface MutableMetricFamily {
  name: string;
  type: string;
  help: string;
  samples: MutableMetricSample[];
}

interface MutableMetricSnapshot {
  protocolVersion: string;
  observedAt: string;
  families: MutableMetricFamily[];
}

function forgedSnapshot(): MutableMetricSnapshot {
  return structuredClone(collectMetrics(input())) as unknown as MutableMetricSnapshot;
}

function renderForged(snapshot: MutableMetricSnapshot): string {
  return toPrometheus(snapshot as unknown as MetricSnapshot);
}

function input(overrides: Partial<DeliveryMetricInput> = {}): DeliveryMetricInput {
  return {
    observedAt: "2026-08-18T00:00:00.000Z",
    backlog: {
      pendingEvents: 12,
      oldestPendingAgeSeconds: 90,
      activeLeases: 2,
      expiredLeases: 1,
    },
    attempts: {
      total: 100,
      byOutcome: { delivered: 80, retry: 10, failed: 8, dead_letter: 2 },
      failuresByReason: { timeout: 4, transport: 2, server: 2 },
    },
    liveness: {
      expectedStreams: 6,
      byState: { healthy: 2, due: 1, overdue: 1, degraded: 1, disabled: 1, never_seen: 0 },
    },
    storage: {
      outboxRows: 100,
      deliveryRows: 120,
      attemptRows: 220,
      totalBytes: 4096,
      managedArtifactRows: 7,
      managedArtifactBytes: 512,
    },
    cost: { egressBytesTotal: 8192, estimatedCostUsdTotal: 0.42 },
    ...overrides,
  };
}

test("collects bounded backlog, liveness, attempts, storage, and cost families", () => {
  const snapshot = collectMetrics(input());
  assert.equal(snapshot.protocolVersion, "0.1");
  assert.equal(snapshot.observedAt, "2026-08-18T00:00:00.000Z");
  assert.equal(snapshot.families.length, 19);
  assert.equal(findMetricFamily(snapshot, "agent_feed_delivery_pending_events")?.samples[0]?.value, 12);
  assert.deepEqual(findMetricFamily(snapshot, "agent_feed_liveness_streams")?.samples.map((sample) => sample.labels.state), [...LIVENESS_STATES]);
  assert.equal(findMetricFamily(snapshot, "agent_feed_delivery_failures_total")?.samples[0]?.value, 8);
  assert.equal(findMetricFamily(snapshot, "agent_feed_delivery_estimated_cost_usd_total")?.samples[0]?.value, 0.42);
});

test("uses the canonical fixed family set and exact durable liveness states", () => {
  const snapshot = collectMetrics(input());
  assert.deepEqual(snapshot.families.map((family) => family.name), [...OBSERVABILITY_FAMILY_NAMES]);
  assert.deepEqual([...LIVENESS_STATES], ["healthy", "due", "overdue", "degraded", "disabled", "never_seen"]);
  assert.equal(findMetricFamily(snapshot, "agent_feed_liveness_expected_streams")?.samples[0]?.value, 6);
});

test("ignores unknown dimensions and never emits tenant or source identifiers", () => {
  const hostile = input({
    attempts: {
      total: 1,
      byOutcome: {
        delivered: 1,
        // Runtime input may come from JavaScript even though TypeScript does
        // not expose this key. It must not become a Prometheus label/value.
        ["tenant-secret-123"]: 999,
      } as NonNullable<DeliveryMetricInput["attempts"]["byOutcome"]>,
      failuresByReason: { unknown: 1 },
    },
  });
  const output = toPrometheus(collectMetrics(hostile));
  assert.equal(output.includes("tenant-secret-123"), false);
  assert.equal(output.includes("tenant_id"), false);
  assert.equal(output.includes("consumer_id"), false);
  assert.match(output, /agent_feed_delivery_attempts_total\{outcome="delivered"\} 1/);
});

test("caps large values without creating unbounded exporter output", () => {
  const snapshot = collectMetrics(input({
    backlog: { pendingEvents: 99, oldestPendingAgeSeconds: 99, activeLeases: 0, expiredLeases: 0 },
    storage: {
      outboxRows: 99,
      deliveryRows: 99,
      attemptRows: 99,
      totalBytes: 99,
      managedArtifactRows: 99,
      managedArtifactBytes: 99,
    },
  }), { maxCount: 10, maxAgeSeconds: 20, maxBytes: 30, maxCostUsd: 40 });
  assert.equal(findMetricFamily(snapshot, "agent_feed_delivery_pending_events")?.samples[0]?.value, 10);
  assert.equal(findMetricFamily(snapshot, "agent_feed_delivery_oldest_pending_age_seconds")?.samples[0]?.value, 20);
  assert.equal(findMetricFamily(snapshot, "agent_feed_storage_bytes")?.samples[0]?.value, 30);
});

test("renders deterministic Prometheus text and optional scrape timestamp", () => {
  const snapshot = collectMetrics(input());
  const first = toPrometheus(snapshot, { includeTimestamp: true });
  const second = toPrometheus(snapshot, { includeTimestamp: true });
  assert.equal(first, second);
  assert.match(first, /^# HELP agent_feed_delivery_pending_events/m);
  assert.match(first, /agent_feed_delivery_pending_events 12 1787011200000/);
});

test("rejects forged family names, types, order, and HELP text before rendering", () => {
  const forgedName = forgedSnapshot();
  forgedName.families[0]!.name = "agent_feed_delivery_pending_events\ninjected_metric 1";
  assert.throws(() => renderForged(forgedName), /invalid_metric_snapshot:families\[0\]\.name:control_character/);

  const forgedHelp = forgedSnapshot();
  forgedHelp.families[0]!.help = "safe\n# TYPE injected_metric counter";
  assert.throws(() => renderForged(forgedHelp), /invalid_metric_snapshot:families\[0\]\.help:control_character/);

  const forgedType = forgedSnapshot();
  forgedType.families[0]!.type = "counter";
  assert.throws(() => renderForged(forgedType), /invalid_metric_snapshot:families\[0\]\.type:unexpected_value/);

  const forgedOrder = forgedSnapshot();
  [forgedOrder.families[0], forgedOrder.families[1]] = [forgedOrder.families[1]!, forgedOrder.families[0]!];
  assert.throws(() => renderForged(forgedOrder), /invalid_metric_snapshot:families\[0\]\.name:unexpected_value/);
});

test("rejects forged labels and control characters without exposing a new series", () => {
  const extraLabel = forgedSnapshot();
  extraLabel.families[4]!.samples[0]!.labels.tenant_id = "tenant-secret";
  assert.throws(() => renderForged(extraLabel), /unexpected_label_count/);

  const forgedValue = forgedSnapshot();
  forgedValue.families[4]!.samples[0]!.labels.outcome = "all\n}\ninjected_metric 1";
  assert.throws(() => renderForged(forgedValue), /invalid_metric_snapshot:families\[4\]\.samples\[0\]\.labels\.outcome:control_character/);

  const forgedKey = forgedSnapshot();
  forgedKey.families[4]!.samples[0]!.labels = { "outcome\nnew_metric": "all" };
  assert.throws(() => renderForged(forgedKey), /control_character/);
});

test("rejects non-finite or negative values and unsafe observation timestamps", () => {
  for (const value of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
    const forgedValue = forgedSnapshot();
    forgedValue.families[0]!.samples[0]!.value = value;
    assert.throws(() => renderForged(forgedValue), /expected_finite_non_negative_number/);
  }

  const controlTimestamp = forgedSnapshot();
  controlTimestamp.observedAt = "2026-08-18T00:00:00.000Z\ninjected";
  assert.throws(() => renderForged(controlTimestamp), /invalid_metric_snapshot:observedAt:control_character/);

  const nonCanonicalTimestamp = forgedSnapshot();
  nonCanonicalTimestamp.observedAt = "2026-08-18T00:00:00Z";
  assert.throws(() => renderForged(nonCanonicalTimestamp), /expected_canonical_iso_timestamp/);
});

test("rejects invalid aggregate values and timestamps", () => {
  assert.throws(() => collectMetrics(input({ observedAt: "not-a-date" })), /observedAt/);
  assert.throws(() => collectMetrics(input({
    backlog: { pendingEvents: -1, oldestPendingAgeSeconds: 0, activeLeases: 0, expiredLeases: 0 },
  })), /backlog\.pendingEvents/);
  assert.throws(() => collectMetrics(input({
    attempts: { total: 1.5 },
  })), /attempts\.total/);
});
