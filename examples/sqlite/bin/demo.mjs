import { SqliteAgentFeedStore } from "../index.mjs";

const store = new SqliteAgentFeedStore();
try {
  const begin = {
    protocol_version: "0.1",
    idempotency_key: "demo-begin-001",
    stream_id: "demo.stream",
    producer: { producer_id: "demo-producer", type: "automation", name: "sqlite-demo", version: "0.1.1" },
    task: { task_type: "demo", definition_id: null, definition_version: null },
    expected_scope: { source_ids: ["source.demo"], subjects: [], queries: [], metadata: {} },
    started_at: "2026-08-18T00:00:00.000Z",
    parent_run_id: null,
    metadata: { purpose: "local reference" },
  };
  const started = store.beginRun(begin);
  const accepted = store.submitBatch({
    protocol_version: "0.1",
    run_id: started.run_id,
    batch_id: "demo-batch-001",
    idempotency_key: "demo-batch-001",
    sequence_number: 1,
    submitted_at: "2026-08-18T00:00:01.000Z",
    findings: [],
    evidence: [{
      evidence_id: "demo-evidence-001",
      kind: "web",
      source: { uri: "https://example.invalid/demo", title: "Synthetic", publisher: "Example", source_id: "source.demo" },
      captured_at: "2026-08-18T00:00:01.000Z",
      published_at: null,
      locator: null,
      excerpt: "Synthetic evidence for the local demo.",
      content_hash: null,
      artifact: { uri: null, media_type: null, size_bytes: null },
      handling: { contains_personal_data: false, contains_secrets: false, redistribution_restricted: false },
      metadata: {},
    }],
    metadata: {},
  });
  const completed = store.completeRun({
    protocol_version: "0.1",
    run_id: started.run_id,
    idempotency_key: "demo-complete-001",
    status: "completed",
    completed_at: "2026-08-18T00:00:02.000Z",
    actual_scope: { source_ids: ["source.demo"], subjects: [], queries: [], metadata: {} },
    stats: { sources_attempted: 1, sources_succeeded: 1, findings_submitted: 0, evidence_submitted: 1, batches_submitted: 1 },
    errors: [],
    metadata: {},
  });
  console.log(JSON.stringify({ run_id: completed.run_id, status: completed.status, batches: accepted.batches.length, evidence: completed.evidence.length }));
} finally {
  store.close();
}
