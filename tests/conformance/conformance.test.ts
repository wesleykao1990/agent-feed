import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

import { importRunBundleFile } from "../../prototype/src/import-file.ts";
import { SECURITY_DEFAULTS, signBody, verifyBody } from "../../prototype/src/security.ts";
import { createAgentFeedServer } from "../../prototype/src/server.ts";
import { AgentFeedStore } from "../../prototype/src/store.ts";
import { RunBundleImporter } from "../../prototype/src/wire.ts";

const prototypeRequire = createRequire(
  new URL("../../prototype/package.json", import.meta.url),
);
const { Ajv2020 } = prototypeRequire("ajv/dist/2020.js") as {
  Ajv2020: new (options: Record<string, unknown>) => {
    addSchema(schema: Record<string, unknown>): void;
    getSchema(id: string): ((value: unknown) => boolean) & {
      errors?: unknown;
    };
  };
};
const addFormats = prototypeRequire("ajv-formats") as (ajv: unknown) => void;

const SCHEMA_NAMES = [
  "begin-run.schema.json",
  "complete-run.schema.json",
  "delivery-event.schema.json",
  "evidence.schema.json",
  "finding.schema.json",
  "run-bundle.schema.json",
  "run-envelope.schema.json",
  "stream-expectation.schema.json",
  "submit-batch.schema.json",
] as const;

const EXAMPLE_PATHS = [
  "examples/rewards-optimizer/begin-run.example.json",
  "examples/rewards-optimizer/complete-run.example.json",
  "examples/rewards-optimizer/delivery-event.example.json",
  "examples/rewards-optimizer/run-bundle.example.json",
  "examples/rewards-optimizer/run-envelope.example.json",
  "examples/rewards-optimizer/submit-batch.example.json",
  "examples/run-bundle.zero-findings.example.json",
  "examples/security/hostile-run-bundle.json",
  "examples/stream-expectation.example.json",
] as const;

type JsonObject = Record<string, any>;

function fixture(path: string): JsonObject {
  return JSON.parse(
    readFileSync(new URL(`../../${path}`, import.meta.url), "utf8"),
  ) as JsonObject;
}

function freshBundle(): JsonObject {
  return fixture("examples/rewards-optimizer/run-bundle.example.json");
}

function schema(name: string): JsonObject {
  return JSON.parse(
    readFileSync(
      new URL(`../../packages/schema/contracts/${name}`, import.meta.url),
      "utf8",
    ),
  ) as JsonObject;
}

function schemaValidators(): Map<string, ((value: unknown) => boolean) & { errors?: unknown }> {
  const ajv = new Ajv2020({
    allErrors: true,
    strict: true,
    strictTypes: false,
  });
  addFormats(ajv);
  for (const name of SCHEMA_NAMES) ajv.addSchema(schema(name));
  return new Map(
    SCHEMA_NAMES.map((name) => {
      const id = schema(name)["$id"] as string;
      const validator = ajv.getSchema(id);
      assert.ok(validator, `schema was not registered: ${name}`);
      return [name, validator];
    }),
  );
}

function assertValid(validator: ((value: unknown) => boolean) & { errors?: unknown }, value: unknown, label: string): void {
  assert.equal(
    validator(value),
    true,
    `${label} did not validate: ${JSON.stringify(validator.errors)}`,
  );
}

function assertNoCamelCaseKeys(value: unknown, path = "<root>"): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoCamelCaseKeys(item, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value as JsonObject)) {
    assert.equal(/[A-Z]/.test(key), false, `camelCase wire key at ${path}.${key}`);
    assertNoCamelCaseKeys(child, `${path}.${key}`);
  }
}

function addSecondBatch(bundle: JsonObject): JsonObject {
  const second = structuredClone(bundle.batches[0]) as JsonObject;
  second.batch_id = "batch_conformance_002";
  second.idempotency_key = "idem_batch_conformance_002";
  second.sequence_number = 2;
  second.evidence = [structuredClone(second.evidence[0])];
  second.evidence[0].evidence_id = "evidence_conformance_002";
  second.findings = [];
  bundle.batches.push(second);
  bundle.complete.stats.batches_submitted = 2;
  bundle.complete.stats.findings_submitted = 1;
  bundle.complete.stats.evidence_submitted = 2;
  return second;
}

function assertRejectedBeforePersistence(
  bundle: JsonObject,
  expected: RegExp,
): void {
  const store = new AgentFeedStore();
  assert.throws(() => new RunBundleImporter(store).import(bundle), expected);
  assert.equal(store.getRun(bundle.run_id), null, "rejected bundle changed store state");
}

async function withServer<T>(callback: (base: string) => Promise<T>): Promise<T> {
  const server = createAgentFeedServer({ token: "conformance-token" });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${address.port}`;
  try {
    return await callback(base);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

test("M0-01 all nine schemas and nine protocol examples validate", () => {
  assert.equal(SCHEMA_NAMES.length, 9);
  assert.equal(EXAMPLE_PATHS.length, 9);
  const validators = schemaValidators();
  const examples = EXAMPLE_PATHS.map((path) => [path, fixture(path)] as const);
  for (const [path, value] of examples) {
    assert.equal(typeof value, "object", `${path} is not a JSON object`);
  }

  const rewards = fixture("examples/rewards-optimizer/run-bundle.example.json");
  const mapping: Array<[string, unknown, string]> = [
    ["begin-run.schema.json", fixture("examples/rewards-optimizer/begin-run.example.json"), "begin-run"],
    ["complete-run.schema.json", fixture("examples/rewards-optimizer/complete-run.example.json"), "complete-run"],
    ["delivery-event.schema.json", fixture("examples/rewards-optimizer/delivery-event.example.json"), "delivery-event"],
    ["evidence.schema.json", rewards.batches[0].evidence[0], "evidence"],
    ["finding.schema.json", rewards.batches[0].findings[0], "finding"],
    ["run-bundle.schema.json", rewards, "run-bundle"],
    ["run-envelope.schema.json", fixture("examples/rewards-optimizer/run-envelope.example.json"), "run-envelope"],
    ["stream-expectation.schema.json", fixture("examples/stream-expectation.example.json"), "stream-expectation"],
    ["submit-batch.schema.json", fixture("examples/rewards-optimizer/submit-batch.example.json"), "submit-batch"],
  ];
  for (const [name, value, label] of mapping) {
    assertValid(validators.get(name)!, value, label);
  }
  assertValid(validators.get("run-bundle.schema.json")!, fixture("examples/run-bundle.zero-findings.example.json"), "zero-findings run-bundle");
  assertValid(validators.get("run-bundle.schema.json")!, fixture("examples/security/hostile-run-bundle.json"), "hostile run-bundle");
});

test("M0-02 wire payloads are snake_case and normalize without losing the original payload", () => {
  const bundle = freshBundle();
  assertNoCamelCaseKeys(bundle);
  const result = new RunBundleImporter(new AgentFeedStore()).import(bundle);
  const finding = result.run.findings[0] as JsonObject;
  const evidence = result.run.evidence[0] as JsonObject;
  assert.equal(finding.findingId, "finding_paypay_route_001");
  assert.equal(finding.wirePayload.finding_id, finding.findingId);
  assert.equal(finding.evidenceRefs[0], "evidence_paypay_001");
  assert.equal(evidence.evidenceId, "evidence_paypay_001");
  assert.equal(evidence.wirePayload.evidence_id, evidence.evidenceId);
  assert.equal(Object.hasOwn(finding, "finding_id"), false);
  assert.equal(Object.hasOwn(evidence, "evidence_id"), false);

  const invalid = structuredClone(bundle) as JsonObject;
  invalid.runId = invalid.run_id;
  assertRejectedBeforePersistence(invalid, /schema_validation_failed/);
});

test("M0-03 semantic invariants reject malformed bundles before begin", async (context) => {
  const cases: Array<[string, (bundle: JsonObject) => void, RegExp]> = [
    ["complete run id mismatch", (bundle) => { bundle.complete.run_id = "run_other_conformance_001"; }, /bundle_run_id_mismatch:complete/],
    ["batch run id mismatch", (bundle) => { bundle.batches[0].run_id = "run_other_conformance_001"; }, /bundle_run_id_mismatch:batch_001/],
    ["completion counts drift", (bundle) => { bundle.complete.stats.findings_submitted = 0; }, /completion_counts_do_not_reconcile/],
    ["sources succeeded exceeds attempted", (bundle) => { bundle.complete.stats.sources_succeeded = 2; }, /invalid_scope_stats/],
    ["completion precedes begin", (bundle) => { bundle.complete.completed_at = "2026-08-17T08:59:00+09:00"; }, /completion_before_start/],
    ["unresolved evidence reference", (bundle) => { bundle.batches[0].findings[0].evidence_refs = ["missing_evidence"]; }, /unresolved_evidence_ref:missing_evidence/],
    ["secret-bearing evidence", (bundle) => { bundle.batches[0].evidence[0].handling.contains_secrets = true; }, /secret_bearing_evidence_rejected:evidence_paypay_001/],
  ];
  for (const [name, mutate, expected] of cases) {
    await context.test(name, () => {
      const bundle = freshBundle();
      mutate(bundle);
      assertRejectedBeforePersistence(bundle, expected);
    });
  }

  const multiBatchCases: Array<[string, (bundle: JsonObject, second: JsonObject) => void, RegExp]> = [
    ["sequence is strictly increasing", (bundle, second) => { second.sequence_number = 1; }, /batch_sequence_not_increasing/],
    ["batch ids are unique", (bundle, second) => { second.batch_id = bundle.batches[0].batch_id; }, /duplicate_batch:batch_001/],
    ["batch idempotency keys are unique", (bundle, second) => { second.idempotency_key = bundle.batches[0].idempotency_key; }, /duplicate_batch_idempotency_key/],
    ["evidence ids are unique", (bundle, second) => { second.evidence[0].evidence_id = bundle.batches[0].evidence[0].evidence_id; }, /duplicate_evidence:evidence_paypay_001/],
    ["finding ids are unique", (bundle, second) => {
      second.findings = [structuredClone(bundle.batches[0].findings[0])];
      second.findings[0].evidence_refs = [second.evidence[0].evidence_id];
      bundle.complete.stats.findings_submitted = 2;
    }, /duplicate_finding:finding_paypay_route_001/],
  ];
  for (const [name, mutate, expected] of multiBatchCases) {
    await context.test(name, () => {
      const bundle = freshBundle();
      const second = addSecondBatch(bundle);
      mutate(bundle, second);
      assertRejectedBeforePersistence(bundle, expected);
    });
  }
});

test("M0-04 retries are idempotent while payload drift is rejected", () => {
  const bundle = freshBundle();
  const importer = new RunBundleImporter(new AgentFeedStore());
  const first = importer.import(bundle);
  const retry = importer.import(structuredClone(bundle));
  assert.equal(first.imported, true);
  assert.equal(retry.imported, false);
  assert.equal(retry.payloadHash, first.payloadHash);
  assert.deepEqual(retry.run, first.run);

  const beforeDrift = retry.run;
  const drifted = structuredClone(bundle) as JsonObject;
  drifted.complete.metadata.retry_note = "payload drift";
  assert.throws(() => importer.import(drifted), /idempotency_payload_conflict/);
  assert.deepEqual(importer.store.getRun(bundle.run_id), beforeDrift);
});

test("M0-05 begin, batch, and completion idempotency preserve terminal immutability", () => {
  const store = new AgentFeedStore();
  const scope = { sourceIds: ["source.conformance"], subjects: ["subject"], queries: ["query"] };
  const begin = {
    runId: "run_conformance_lifecycle_001",
    streamId: "conformance.lifecycle",
    producerId: "producer.conformance",
    idempotencyKey: "begin_conformance_001",
    startedAt: "2026-08-17T00:00:00Z",
    expectedScope: scope,
  };
  const started = store.beginRun(begin);
  assert.deepEqual(started, store.beginRun(structuredClone(begin)));
  assert.throws(
    () => store.beginRun({ ...begin, expectedScope: { ...scope, subjects: ["drift"] } }),
    /idempotency_payload_conflict/,
  );

  const batch = {
    runId: started.runId,
    batchId: "batch_conformance_001",
    idempotencyKey: "batch_conformance_001",
    findings: [],
    evidence: [],
  };
  const accepted = store.submitBatch(batch);
  assert.deepEqual(accepted, store.submitBatch(structuredClone(batch)));
  assert.throws(
    () => store.submitBatch({ ...batch, findings: [{
      findingId: "finding_drift",
      findingType: "conformance",
      title: "Drift",
      summary: "Drift payload",
      subjects: [],
      evidenceRefs: [],
      securityFlags: [],
      attributes: {},
    }] }),
    /idempotency_payload_conflict/,
  );

  const completion = {
    runId: started.runId,
    idempotencyKey: "complete_conformance_001",
    status: "completed" as const,
    completedAt: "2026-08-17T00:01:00Z",
    actualScope: scope,
    sourcesAttempted: 1,
    sourcesSucceeded: 1,
  };
  const completed = store.completeRun(completion);
  assert.deepEqual(completed, store.completeRun(structuredClone(completion)));
  assert.throws(
    () => store.completeRun({ ...completion, completedAt: "2026-08-17T00:02:00Z" }),
    /terminal_run_immutable/,
  );
  assert.throws(() => store.submitBatch({ ...batch, idempotencyKey: "batch_after_terminal" }), /terminal_run_immutable/);
  assert.deepEqual(store.getRun(started.runId), completed);
});

test("M0-06 completion counts reconcile and zero findings are not an absent run", () => {
  const zero = fixture("examples/run-bundle.zero-findings.example.json");
  const store = new AgentFeedStore();
  const result = new RunBundleImporter(store).import(zero);
  assert.equal(result.run.status, "completed");
  assert.equal(result.run.findings.length, 0);
  assert.equal(result.run.evidence.length, 0);
  assert.notEqual(store.getRun(zero.run_id), null);
  assert.equal(store.getRun("run_that_was_never_seen"), null);

  const drifted = freshBundle();
  drifted.complete.stats.evidence_submitted = 0;
  assertRejectedBeforePersistence(drifted, /completion_counts_do_not_reconcile/);
});

test("M0-07 hostile instructions remain untrusted, flagged, and preserved", () => {
  const hostile = fixture("examples/security/hostile-run-bundle.json");
  const result = new RunBundleImporter(new AgentFeedStore()).import(hostile);
  const finding = result.run.findings[0] as JsonObject;
  assert.deepEqual(finding.securityFlags, ["embedded_instruction", "attempted_authority_escalation"]);
  assert.equal(finding.wirePayload.finding_id, "finding_hostile_100_percent");
  assert.equal(finding.wirePayload.attributes.attempted_action, "publish_automatically");
  assert.equal(result.run.status, "completed");
});

test("M1-01 body and batch limits reject oversized inputs before persistence", async () => {
  const oversizedBody = JSON.stringify({ padding: "x".repeat(SECURITY_DEFAULTS.maxBodyBytes) });
  assert.throws(
    () => new RunBundleImporter(new AgentFeedStore()).importJson(oversizedBody),
    /body_too_large/,
  );

  const tooManyEvidence = freshBundle();
  const template = tooManyEvidence.batches[0].evidence[0];
  tooManyEvidence.batches[0].findings = [];
  tooManyEvidence.batches[0].evidence = Array.from(
    { length: SECURITY_DEFAULTS.maxEvidencePerBatch + 1 },
    (_, index) => ({
      ...structuredClone(template),
      evidence_id: `evidence_limit_${String(index).padStart(3, "0")}`,
    }),
  );
  tooManyEvidence.complete.stats.findings_submitted = 0;
  tooManyEvidence.complete.stats.evidence_submitted = tooManyEvidence.batches[0].evidence.length;
  assertRejectedBeforePersistence(tooManyEvidence, /batch_limit_exceeded/);

  await withServer(async (base) => {
    const response = await fetch(`${base}/import-run-bundle`, {
      method: "POST",
      headers: {
        authorization: "Bearer conformance-token",
        "content-type": "application/json",
      },
      body: oversizedBody,
    });
    assert.equal(response.status, 413);
  });
});

test("M1-02 local-file and REST bundle ingestion produce the same result", async () => {
  const raw = readFileSync(
    new URL("../../examples/run-bundle.zero-findings.example.json", import.meta.url),
    "utf8",
  );
  const directory = await mkdtemp(join(tmpdir(), "agent-feed-conformance-"));
  const path = join(directory, "run-bundle.zero-findings.example.json");
  await writeFile(path, raw, "utf8");
  const local = await importRunBundleFile(path);

  await withServer(async (base) => {
    const response = await fetch(`${base}/import-run-bundle`, {
      method: "POST",
      headers: {
        authorization: "Bearer conformance-token",
        "content-type": "application/json",
      },
      body: raw,
    });
    assert.equal(response.status, 201);
    const remote = await response.json();
    assert.deepEqual(remote, local);

    const retry = await fetch(`${base}/import-run-bundle`, {
      method: "POST",
      headers: {
        authorization: "Bearer conformance-token",
        "content-type": "application/json",
      },
      body: raw,
    });
    assert.equal(retry.status, 200);
    assert.equal((await retry.json()).imported, false);
  });
});

test("M1-03 REST distinguishes an absent run from a completed zero-finding run", async () => {
  const raw = readFileSync(
    new URL("../../examples/run-bundle.zero-findings.example.json", import.meta.url),
    "utf8",
  );
  await withServer(async (base) => {
    const absent = await fetch(`${base}/runs/run_not_seen_conformance`, {
      headers: { authorization: "Bearer conformance-token" },
    });
    assert.equal(absent.status, 404);
    assert.equal((await absent.json()).error, "run_not_found");

    const imported = await fetch(`${base}/import-run-bundle`, {
      method: "POST",
      headers: {
        authorization: "Bearer conformance-token",
        "content-type": "application/json",
      },
      body: raw,
    });
    assert.equal(imported.status, 201);

    const zero = await fetch(`${base}/runs/run_zero_findings_20260817_001`, {
      headers: { authorization: "Bearer conformance-token" },
    });
    assert.equal(zero.status, 200);
    const run = await zero.json();
    assert.equal(run.status, "completed");
    assert.deepEqual(run.findings, []);
    assert.deepEqual(run.evidence, []);
  });
});

test("M1-04 HMAC signatures enforce the replay window", () => {
  const body = JSON.stringify({ protocol_version: "0.1", run_id: "run_hmac_001" });
  const secret = "conformance-secret";
  const timestamp = 1_000_000;
  const signature = signBody(body, timestamp, secret);
  assert.equal(verifyBody(body, timestamp, signature, secret, timestamp), true);
  assert.equal(
    verifyBody(body, timestamp, signature, secret, timestamp + SECURITY_DEFAULTS.replayWindowSeconds),
    true,
  );
  assert.equal(
    verifyBody(body, timestamp, signature, secret, timestamp + SECURITY_DEFAULTS.replayWindowSeconds + 1),
    false,
  );
  assert.equal(verifyBody(`${body} `, timestamp, signature, secret, timestamp), false);
  assert.equal(verifyBody(body, timestamp, signature, "wrong-secret", timestamp), false);
});
