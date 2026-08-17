import test from "node:test";
import assert from "node:assert/strict";
import { AgentFeedStore } from "../src/store.ts";
import { verifySignedDeliveryEvent } from "../src/events.ts";

const scope = { sourceIds: ["source-a", "source-b"], subjects: ["demo"], queries: ["changes"] };

function register(store: AgentFeedStore, streamId = "demo.daily"): void {
  store.registerExpectation({
    streamId,
    expectedCadenceSeconds: 3600,
    graceSeconds: 60,
    enabled: true,
    expectedSourceIds: ["source-a", "source-b"],
    owner: "consumer-test",
    lastTerminalRunAt: "2026-08-17T00:00:00Z",
    lastTerminalStatus: "completed",
    lastTerminalRunId: "run_seed_01",
    lastTerminalFindingCount: 0,
  });
}

function begin(store: AgentFeedStore, runId: string, streamId = "demo.daily") {
  return store.beginRun({
    runId,
    streamId,
    producerId: "producer-test",
    idempotencyKey: `begin-${runId}`,
    startedAt: "2026-08-17T01:02:00Z",
    expectedScope: scope,
  });
}

test("missed-run incident opens once, resolves on recovery, and remains auditable", () => {
  const store = new AgentFeedStore();
  register(store);

  const first = store.evaluateLiveness("2026-08-17T01:01:01Z")[0]!;
  const second = store.evaluateLiveness("2026-08-17T01:30:00Z")[0]!;
  assert.equal(first.status, "overdue");
  assert.equal(second.status, "overdue");
  assert.deepEqual(first.affectedSourceIds, ["source-a", "source-b"]);
  assert.equal(first.incident?.status, "open");
  assert.equal(second.incident?.incidentId, first.incident?.incidentId);
  assert.equal(store.listLivenessIncidents("demo.daily").length, 1);

  const run = begin(store, "run_recovery_01");
  store.completeRun({
    runId: run.runId,
    idempotencyKey: "complete-recovery-01",
    status: "completed",
    completedAt: "2026-08-17T01:31:00Z",
    actualScope: scope,
    sourcesAttempted: 2,
    sourcesSucceeded: 2,
  });
  const incident = store.listLivenessIncidents("demo.daily")[0]!;
  assert.equal(incident.status, "resolved");
  assert.equal(incident.resolvedAt, "2026-08-17T01:31:00Z");
  assert.equal(incident.details.recoveredByRunId, run.runId);
  assert.equal(store.evaluateLiveness("2026-08-17T01:32:00Z")[0]?.incident, null);
  assert.equal(store.listLivenessIncidents("demo.daily").length, 1);
});

test("zero findings, absent runs, and degraded terminal runs have distinct observations", () => {
  const absent = new AgentFeedStore();
  absent.registerExpectation({
    streamId: "absent.daily",
    expectedCadenceSeconds: 3600,
    graceSeconds: 60,
    enabled: true,
    expectedSourceIds: ["source-a"],
    owner: "consumer-test",
  });
  const absentResult = absent.evaluateLiveness("2026-08-17T04:00:00Z")[0]!;
  assert.equal(absentResult.status, "never_seen");
  assert.equal(absentResult.observation, "absent_run");

  const store = new AgentFeedStore();
  register(store);
  const zero = begin(store, "run_zero_01");
  store.completeRun({
    runId: zero.runId,
    idempotencyKey: "complete-zero-01",
    status: "completed",
    completedAt: "2026-08-17T01:03:00Z",
    actualScope: scope,
    sourcesAttempted: 2,
    sourcesSucceeded: 2,
  });
  let result = store.evaluateLiveness("2026-08-17T01:04:00Z")[0]!;
  assert.equal(result.status, "healthy");
  assert.equal(result.observation, "zero_findings");
  assert.deepEqual(result.affectedSourceIds, []);

  const partial = begin(store, "run_partial_01");
  store.completeRun({
    runId: partial.runId,
    idempotencyKey: "complete-partial-01",
    status: "partial",
    completedAt: "2026-08-17T01:05:00Z",
    actualScope: { sourceIds: ["source-a"], subjects: ["demo"], queries: ["changes"] },
    sourcesAttempted: 2,
    sourcesSucceeded: 1,
    errorSummary: "source-b unavailable",
  });
  result = store.evaluateLiveness("2026-08-17T01:06:00Z")[0]!;
  assert.equal(result.status, "degraded");
  assert.equal(result.observation, "partial");
  assert.deepEqual(result.affectedSourceIds, ["source-b"]);

  const failed = begin(store, "run_failed_01");
  store.completeRun({
    runId: failed.runId,
    idempotencyKey: "complete-failed-01",
    status: "failed",
    completedAt: "2026-08-17T01:07:00Z",
    actualScope: { sourceIds: [], subjects: [], queries: [] },
    sourcesAttempted: 2,
    sourcesSucceeded: 0,
    errorSummary: "producer unavailable",
  });
  result = store.evaluateLiveness("2026-08-17T01:08:00Z")[0]!;
  assert.equal(result.status, "degraded");
  assert.equal(result.observation, "failed");
  assert.deepEqual(result.affectedSourceIds, ["source-a", "source-b"]);
});

test("finding and terminal event payloads are immutable and signed with replay checks", () => {
  const store = new AgentFeedStore();
  register(store, "events.daily");
  const run = begin(store, "run_events_01", "events.daily");
  store.submitBatch({
    runId: run.runId,
    batchId: "batch-events-01",
    idempotencyKey: "batch-events-key-01",
    occurredAt: "2026-08-17T01:02:30Z",
    evidence: [{ evidenceId: "evidence-01", kind: "web", sourceUri: "https://example.invalid", excerpt: "synthetic" }],
    findings: [{
      findingId: "finding-01",
      findingType: "demo.change",
      title: "Synthetic change",
      summary: "A synthetic finding",
      subjects: [],
      evidenceRefs: ["evidence-01"],
      securityFlags: [],
      attributes: { synthetic: true },
    }],
  });
  store.completeRun({
    runId: run.runId,
    idempotencyKey: "complete-events-01",
    status: "completed",
    completedAt: "2026-08-17T01:03:00Z",
    actualScope: scope,
    sourcesAttempted: 2,
    sourcesSucceeded: 2,
  });

  const events = store.listEvents(run.runId);
  assert.deepEqual(events.map((event) => event.eventType), ["finding.submitted", "run.completed"]);
  const returned = store.listEvents(run.runId);
  (returned[0]!.payload.finding as { title: string }).title = "mutated outside store";
  assert.equal((store.listEvents(run.runId)[0]!.payload.finding as { title: string }).title, "Synthetic change");

  const signed = store.signedEvents(run.runId, "event-secret", { timestampSeconds: 1_755_390_000 });
  assert.equal(signed.length, 2);
  assert.ok(signed.every((event) => verifySignedDeliveryEvent(event, "event-secret", 1_755_390_100)));
  assert.ok(signed.every((event) => store.verifySignedEvent(event, "event-secret", 1_755_390_100)));
  assert.equal(verifySignedDeliveryEvent(signed[0]!, "event-secret", 1_755_390_400), false);
  signed[0]!.payload.finding = { tampered: true };
  assert.equal(verifySignedDeliveryEvent(signed[0]!, "event-secret", 1_755_390_100), false);
});
