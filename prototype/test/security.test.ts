import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  ProducerRateLimiter,
  StaticProducerAuthenticator,
  constantTimeEqual,
  verifyBody,
  signBody,
} from "../src/security.ts";
import { AgentFeedStore } from "../src/store.ts";
import { RunBundleImporter } from "../src/wire.ts";

function fixture(path: string): any {
  return JSON.parse(readFileSync(new URL("../../" + path, import.meta.url), "utf8"));
}

test("static producer credentials are scoped and expired credentials are rejected", () => {
  const authenticator = new StaticProducerAuthenticator([
    {
      producerId: "producer-a",
      secret: "secret-a",
      allowedStreamIds: ["stream-a"],
      expiresAt: 100,
    },
  ]);
  const principal = authenticator.authenticate({ authorization: "Bearer secret-a", nowSeconds: 99 });
  assert.equal(principal?.producerId, "producer-a");
  assert.deepEqual(principal?.allowedStreamIds, ["stream-a"]);
  assert.equal(authenticator.authenticate({ authorization: "Bearer secret-a", nowSeconds: 100 }), null);
  assert.equal(authenticator.authenticate({ authorization: "Bearer wrong-secret", nowSeconds: 99 }), null);
  assert.equal(constantTimeEqual("secret-a", "wrong-secret"), false);
});

test("producer rate limiter is isolated by producer and returns a retry window", () => {
  let now = 10_000;
  const limiter = new ProducerRateLimiter({ maxRequestsPerMinute: 2, now: () => now });
  assert.equal(limiter.assertAllowed("producer-a").remaining, 1);
  assert.equal(limiter.assertAllowed("producer-a").remaining, 0);
  const limited = limiter.consume("producer-a");
  assert.equal(limited.allowed, false);
  assert.equal(limited.retryAfterSeconds, 60);
  assert.equal(limiter.assertAllowed("producer-b").allowed, true);
  now += 60_001;
  assert.equal(limiter.assertAllowed("producer-a").allowed, true);
});

test("HMAC credentials reject stale, malformed, and invalid signatures", () => {
  const body = JSON.stringify({ hello: "world" });
  const signature = signBody(body, 1_000, "secret");
  assert.equal(verifyBody(body, 1_000, signature, "secret", 1_100), true);
  assert.equal(verifyBody(body, 1_000, signature, "secret", 1_301), false);
  assert.equal(verifyBody(body, 1_000, "not-hex", "secret", 1_100), false);
  assert.equal(verifyBody(body, 1_000, signature.replace(/.$/, "0"), "secret", 1_100), false);
});

test("hostile flags and PII invoke quarantine hooks without promoting content", () => {
  const events: string[] = [];
  const store = new AgentFeedStore();
  const importer = new RunBundleImporter(store, {
    security: {
      onQuarantine: (event) => events.push(`${event.kind}:${event.reason}`),
    },
  });
  const hostile = fixture("examples/security/hostile-run-bundle.json");
  const personal = fixture("examples/rewards-optimizer/run-bundle.example.json");
  personal.run_id = "run_personal_data_001";
  personal.begin.idempotency_key = "idem_personal_begin_001";
  personal.complete.idempotency_key = "idem_personal_complete_001";
  personal.batches[0].run_id = personal.run_id;
  personal.complete.run_id = personal.run_id;
  personal.batches[0].evidence[0].handling.contains_personal_data = true;
  importer.import(hostile);
  new RunBundleImporter(new AgentFeedStore(), {
    security: {
      onQuarantine: (event) => events.push(`${event.kind}:${event.reason}`),
    },
  }).import(personal);
  assert.ok(events.includes("finding:security_flag"));
  assert.ok(events.includes("evidence:personal_data"));
});

test("PII rejection is opt-in and happens before the run begins", () => {
  const store = new AgentFeedStore();
  const bundle = fixture("examples/rewards-optimizer/run-bundle.example.json");
  bundle.batches[0].evidence[0].handling.contains_personal_data = true;
  assert.throws(
    () => new RunBundleImporter(store, { security: { rejectPersonalData: true } }).import(bundle),
    /personal_data_rejected/,
  );
  assert.equal(store.getRun(bundle.run_id), null);
});

test("body and Unicode excerpt limits are enforced before persistence", () => {
  const bodyStore = new AgentFeedStore();
  const bodyImporter = new RunBundleImporter(bodyStore, { security: { maxBodyBytes: 32 } });
  assert.throws(
    () => bodyImporter.importJson(JSON.stringify(fixture("examples/run-bundle.zero-findings.example.json"))),
    /body_too_large/,
  );
  assert.equal(bodyStore.getRun("run_zero_findings_20260817_001"), null);

  const excerptStore = new AgentFeedStore();
  const excerptImporter = new RunBundleImporter(excerptStore, {
    security: { maxEvidenceExcerptCharacters: 2 },
  });
  const bundle = fixture("examples/rewards-optimizer/run-bundle.example.json");
  bundle.batches[0].evidence[0].excerpt = "😀😀😀";
  assert.throws(() => excerptImporter.import(bundle), /evidence_excerpt_too_large/);
  assert.equal(excerptStore.getRun(bundle.run_id), null);
});

test("secret evidence can be quarantined and retained only when explicitly allowed", () => {
  const events: string[] = [];
  const store = new AgentFeedStore();
  const bundle = fixture("examples/rewards-optimizer/run-bundle.example.json");
  bundle.run_id = "run_secret_quarantine_001";
  bundle.begin.idempotency_key = "idem_secret_quarantine_begin_001";
  bundle.complete.idempotency_key = "idem_secret_quarantine_complete_001";
  bundle.batches[0].run_id = bundle.run_id;
  bundle.complete.run_id = bundle.run_id;
  bundle.batches[0].evidence[0].handling.contains_secrets = true;
  const result = new RunBundleImporter(store, {
    security: {
      rejectSecrets: false,
      onQuarantine: (event) => events.push(event.reason),
    },
  }).import(bundle);
  assert.equal(result.run.evidence[0]?.handling?.containsSecrets, true);
  assert.deepEqual(events, ["secret_bearing_evidence"]);
});
