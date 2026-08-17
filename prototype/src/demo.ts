import { AgentFeedStore } from "./store.ts";

const store = new AgentFeedStore();
store.registerExpectation({
  streamId: "rewards.daily", expectedCadenceSeconds: 86400, graceSeconds: 3600,
  enabled: true, expectedSourceIds: ["source.demo"], owner: "prototype",
  lastTerminalRunAt: "2026-08-16T00:00:00Z",
});
const run = store.beginRun({
  runId: "run_demo_0001", streamId: "rewards.daily", producerId: "prototype-monitor",
  idempotencyKey: "begin-demo-1", startedAt: "2026-08-17T00:00:00Z",
  expectedScope: { sourceIds: ["source.demo"], subjects: ["Demo"], queries: ["demo change"] },
});
store.submitBatch({ runId: run.runId, batchId: "batch_1", idempotencyKey: "batch-demo-1", findings: [], evidence: [] });
store.completeRun({ runId: run.runId, idempotencyKey: "complete-demo-1", status: "completed", completedAt: "2026-08-17T00:01:00Z", actualScope: run.expectedScope, sourcesAttempted: 1, sourcesSucceeded: 1 });
console.log(JSON.stringify({ run: store.getRun(run.runId), liveness: store.evaluateLiveness("2026-08-17T12:00:00Z") }, null, 2));
