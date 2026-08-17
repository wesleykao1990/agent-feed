import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { AgentFeedStore } from "../src/store.ts";
import { RunBundleImporter } from "../src/wire.ts";

function fixture(path: string): any {
  return JSON.parse(readFileSync(new URL("../../" + path, import.meta.url), "utf8"));
}

test("portable zero-finding bundle imports and retries idempotently", () => {
  const store = new AgentFeedStore();
  const importer = new RunBundleImporter(store);
  const bundle = fixture("examples/run-bundle.zero-findings.example.json");
  const first = importer.import(bundle);
  const retry = importer.import(bundle);
  assert.equal(first.imported, true);
  assert.equal(retry.imported, false);
  assert.equal(first.payloadHash, retry.payloadHash);
  assert.equal(retry.run.status, "completed");
  assert.equal(retry.run.findings.length, 0);
});

test("wire import preserves hostile security flags and original untrusted payload", () => {
  const store = new AgentFeedStore();
  const result = new RunBundleImporter(store).import(
    fixture("examples/security/hostile-run-bundle.json"),
  );
  assert.deepEqual(result.run.findings[0]?.securityFlags, [
    "embedded_instruction",
    "attempted_authority_escalation",
  ]);
  assert.equal(
    result.run.findings[0]?.wirePayload?.finding_id,
    "finding_hostile_100_percent",
  );
  assert.equal(result.run.evidence[0]?.handling?.containsSecrets, false);
});

test("schema-invalid bundle is rejected before state changes", () => {
  const store = new AgentFeedStore();
  const importer = new RunBundleImporter(store);
  const bundle = fixture("examples/run-bundle.zero-findings.example.json");
  bundle.protocol_version = "9.9";
  assert.throws(() => importer.import(bundle), /schema_validation_failed/);
  assert.equal(store.getRun(bundle.run_id), null);
});

test("completion counts must reconcile before import", () => {
  const store = new AgentFeedStore();
  const importer = new RunBundleImporter(store);
  const bundle = fixture("examples/rewards-optimizer/run-bundle.example.json");
  bundle.complete.stats.findings_submitted = 2;
  assert.throws(() => importer.import(bundle), /completion_counts_do_not_reconcile/);
  assert.equal(store.getRun(bundle.run_id), null);
});

test("bundle retry with payload drift conflicts", () => {
  const importer = new RunBundleImporter(new AgentFeedStore());
  const bundle = fixture("examples/run-bundle.zero-findings.example.json");
  importer.import(bundle);
  const changed = structuredClone(bundle);
  changed.complete.metadata.retry_note = "changed payload";
  assert.throws(() => importer.import(changed), /idempotency_payload_conflict/);
});

test("secret-bearing evidence is rejected before persistence", () => {
  const store = new AgentFeedStore();
  const importer = new RunBundleImporter(store);
  const bundle = fixture("examples/rewards-optimizer/run-bundle.example.json");
  bundle.batches[0].evidence[0].handling.contains_secrets = true;
  assert.throws(() => importer.import(bundle), /secret_bearing_evidence_rejected/);
  assert.equal(store.getRun(bundle.run_id), null);
});

test("security batch limits are checked before begin mutates state", () => {
  const store = new AgentFeedStore();
  const importer = new RunBundleImporter(store);
  const bundle = fixture("examples/rewards-optimizer/run-bundle.example.json");
  const evidenceTemplate = bundle.batches[0].evidence[0];
  bundle.batches[0].findings = [];
  bundle.batches[0].evidence = Array.from({ length: 101 }, (_, index) => ({
    ...structuredClone(evidenceTemplate),
    evidence_id: "evidence_limit_" + String(index).padStart(3, "0"),
  }));
  bundle.complete.stats.findings_submitted = 0;
  bundle.complete.stats.evidence_submitted = 101;
  assert.throws(() => importer.import(bundle), /batch_limit_exceeded/);
  assert.equal(store.getRun(bundle.run_id), null);
});
