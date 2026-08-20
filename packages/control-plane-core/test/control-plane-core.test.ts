import assert from "node:assert/strict";
import test from "node:test";
import { controlPlaneSnapshotState, normalizeControlPlaneSnapshot, type ControlPlaneSnapshotInput } from "../src/index.ts";

const snapshot = (overrides: Partial<ControlPlaneSnapshotInput> = {}): ControlPlaneSnapshotInput => ({
  tenantId: "tenant-a", generatedAt: "2026-08-20T00:00:00.000Z", freshnessWindowSeconds: 60,
  observationWindow: { from: "2026-08-19T00:00:00.000Z", to: "2026-08-20T00:00:00.000Z" },
  jobs: { total: 1, byState: { draft: 0, shadow: 0, active: 1, paused: 0, retired: 0 } },
  occurrences: { total: 1, byState: { pending: 0, absent: 0, running: 0, completed_zero: 1, completed: 0, partial: 0, failed: 0, cancelled: 0 } },
  runs: { total: 1, byState: { running: 0, completed: 1, partial: 0, failed: 0, cancelled: 0 } },
  assessments: { total: 1, byState: { passed: 1, failed: 0, inconclusive: 0, unknown: 0 } },
  deliveries: { total: 1, byState: { queued: 0, leased: 0, retry: 0, acknowledged: 1, dead_letter: 0 } },
  failures: [], ...overrides,
});

test("normalizes a tenant-scoped payload-free healthy snapshot", () => {
  const result = normalizeControlPlaneSnapshot(snapshot());
  assert.equal(result.schemaVersion, "agent-feed.control-plane.v1");
  assert.equal(result.tenantId, "tenant-a");
  assert.equal(result.health, "healthy");
  assert.deepEqual(Object.keys(result.failures), ["provider", "gateway", "execution", "validation", "delivery"]);
});

test("distinguishes each failure layer without raw diagnostic detail", () => {
  for (const layer of ["provider", "gateway", "execution", "validation", "delivery"] as const) {
    const result = normalizeControlPlaneSnapshot(snapshot({ failures: [{ layer, count: 1 }] }));
    assert.equal(result.failures[layer], 1);
    assert.equal(result.health, layer === "validation" || layer === "delivery" ? "degraded" : "critical");
  }
});

test("zero-finding completion remains distinct from absence", () => {
  const result = normalizeControlPlaneSnapshot(snapshot());
  assert.equal(result.occurrences.byState.completed_zero, 1);
  assert.equal(result.occurrences.byState.absent, 0);
});

test("rejects unreconciled, unknown, fractional, and oversized aggregate states", () => {
  assert.throws(() => normalizeControlPlaneSnapshot(snapshot({ jobs: { total: 2, byState: { draft: 0, shadow: 0, active: 1, paused: 0, retired: 0 } } })), /total_does_not_reconcile/);
  assert.throws(() => normalizeControlPlaneSnapshot(snapshot({ runs: { total: 1, byState: { running: 0, completed: 1, partial: 0, failed: 0, cancelled: 0, leaked: 1 } as never } })), /unknown_state/);
  assert.throws(() => normalizeControlPlaneSnapshot(snapshot({ deliveries: { total: 1.5, byState: { queued: 0, leased: 0, retry: 0, acknowledged: 1, dead_letter: 0 } } })), /safe_integer/);
});

test("rejects payload-shaped or credential-shaped top-level additions by contract", () => {
  const hostile = { ...snapshot(), evidence: { excerpt: "raw" }, authorization: "Bearer secret" };
  assert.throws(() => normalizeControlPlaneSnapshot(hostile), /evidence:unknown_field/);
  assert.throws(() => normalizeControlPlaneSnapshot(snapshot({ failures: [{ layer: "provider", count: 1, errorDetail: "raw" } as never] })), /errorDetail:unknown_field/);
  assert.throws(() => normalizeControlPlaneSnapshot(snapshot({ runs: { total: 1, byState: { running: 0, completed: 1, partial: 0, failed: 0, cancelled: 0 }, payload: "raw" } as never })), /runs.payload:unknown_field/);
  assert.throws(() => normalizeControlPlaneSnapshot(snapshot({ failures: {} as never })), /failures:array_required/);
});

test("reports freshness and rejects excessive future clock skew", () => {
  const state = controlPlaneSnapshotState(snapshot(), Date.parse("2026-08-20T00:02:00.000Z"));
  assert.equal(state.stale, true);
  assert.equal(state.ageSeconds, 120);
  assert.throws(() => controlPlaneSnapshotState(snapshot({ generatedAt: "2026-08-20T00:02:00.000Z" }), Date.parse("2026-08-20T00:00:00.000Z")), /future_clock_skew/);
});

test("requires an explicit, ordered observation window", () => {
  assert.throws(() => normalizeControlPlaneSnapshot(snapshot({ observationWindow: { from: "2026-08-21T00:00:00.000Z", to: "2026-08-20T00:00:00.000Z" } })), /from_after_to/);
  assert.throws(() => normalizeControlPlaneSnapshot(snapshot({ observationWindow: { from: "2026-08-19T00:00:00.000Z", to: "2026-08-20T00:00:00.000Z", payload: "secret" } as never })), /unknown_field/);
});
