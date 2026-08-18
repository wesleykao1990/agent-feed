import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const PACKAGE_ROOT = join(ROOT, "examples/rewards-optimizer");
const PACKAGE_MANIFEST = join(PACKAGE_ROOT, "package.json");
const BASE_EVENT_PATH = join(PACKAGE_ROOT, "delivery-event.example.json");
const HOSTILE_BUNDLE_PATH = join(ROOT, "examples/security/hostile-run-bundle.json");

const BASE_SCOPE = {
  tenant_id: "tenant_m4_reference",
  consumer_id: "consumer_m4_reference",
  allowed_stream_ids: ["rewards-optimizer.source-monitor", "rewards-optimizer.secondary-monitor"],
};

function clone(value) {
  return structuredClone(value);
}

function fixture(pathname) {
  return JSON.parse(readFileSync(pathname, "utf8"));
}

function publicExportTarget(manifest) {
  const rootExport = manifest.exports?.["."] ?? manifest.exports;
  if (typeof rootExport === "string") return rootExport;
  if (rootExport && typeof rootExport === "object") {
    for (const key of ["import", "default", "require"]) {
      if (typeof rootExport[key] === "string") return rootExport[key];
    }
  }
  for (const key of ["module", "main"]) {
    if (typeof manifest[key] === "string") return manifest[key];
  }
  throw new Error("reference package does not declare a public export target");
}

async function loadPublicPackage() {
  const manifest = JSON.parse(readFileSync(PACKAGE_MANIFEST, "utf8"));
  const target = publicExportTarget(manifest);
  assert.ok(!/(?:^|[\\/])src(?:[\\/]|$)/u.test(target), `M4 tests must import the public build, not ${target}`);
  const targetPath = resolve(PACKAGE_ROOT, target.replace(/^\.\//u, ""));
  return import(`${pathToFileURL(targetPath).href}?m4=${Date.now()}`);
}

function newConsumer(api, scope = BASE_SCOPE) {
  assert.equal(typeof api.ReferenceConsumer, "function", "public package must export ReferenceConsumer");
  return new api.ReferenceConsumer(scope);
}

function assertNoForbiddenDomainOutput(value) {
  const forbiddenKey = /^(?:reward_rule(?:_version)?|canonical_evidence(?:_ids)?|canonical_source_snapshot|promotion(?:_output|_decision)?|promoted_rule|verified_fact)$/iu;
  const verifiedKey = /^(?:verified|is_verified|trusted)$/iu;
  function visit(node, path = "$") {
    if (Array.isArray(node)) {
      node.forEach((item, index) => visit(item, `${path}[${index}]`));
      return;
    }
    if (node === null || typeof node !== "object") return;
    for (const [key, child] of Object.entries(node)) {
      assert.equal(forbiddenKey.test(key), false, `forbidden domain output at ${path}.${key}`);
      if (verifiedKey.test(key) && child === true) {
        assert.fail(`untrusted observation was marked verified/trusted at ${path}.${key}`);
      }
      visit(child, `${path}.${key}`);
    }
  }
  visit(value);
}

function jsonHas(value, expected) {
  return JSON.stringify(value).includes(expected);
}

function assertUntrustedObservation(result, event, scope) {
  assert.ok(result && typeof result === "object");
  assert.ok(result.observation && typeof result.observation === "object", "result must expose an observation");
  const observation = result.observation;
  assert.equal(observation.trust, "untrusted");
  assert.equal(observation.promotion_status, "not_promoted");
  assert.equal(observation.transport?.event_id, event.event_id);
  assert.equal(observation.transport?.consumer_id, scope.consumer_id);
  assert.equal(observation.transport?.run_id, event.run_id);
  assert.equal(observation.transport?.stream_id, event.stream_id);
  assert.ok(jsonHas(observation, scope.tenant_id), "tenant scope must be preserved in the observation");
  assert.equal(observation.finding?.finding_id, event.finding_id);
  assert.deepEqual(observation.submitted_evidence, event.payload.submitted_evidence);
  assert.equal(observation.finding?.assessment?.agent_confidence, event.payload.finding.assessment.agent_confidence);
  assert.equal(observation.finding?.assessment?.source_authority_claim, event.payload.finding.assessment.source_authority_claim);
  assertNoForbiddenDomainOutput(result);
  return observation;
}

function hostileDeliveryEvent() {
  const bundle = fixture(HOSTILE_BUNDLE_PATH);
  const batch = bundle.batches[0];
  const finding = batch.findings[0];
  return {
    protocol_version: "0.1",
    event_id: "event_m4_hostile_001",
    event_type: "finding.submitted",
    stream_id: bundle.begin.stream_id,
    run_id: bundle.run_id,
    finding_id: finding.finding_id,
    occurred_at: batch.submitted_at,
    attempt: 1,
    payload: {
      finding: clone(finding),
      submitted_evidence: clone(batch.evidence),
    },
  };
}

test("public package import exposes only the reference observation surface", async () => {
  const api = await loadPublicPackage();
  assert.equal(typeof api.ReferenceConsumer, "function");
  assert.equal(typeof api.mapDeliveryEvent, "function");
  for (const name of Object.keys(api)) {
    assert.equal(/RewardRule|CanonicalEvidence|CanonicalSourceSnapshot|promote.*Rule|publish.*Rule/iu.test(name), false, `forbidden public export ${name}`);
  }
});

test("maps an untrusted finding and preserves submitted evidence without canonical promotion", async () => {
  const api = await loadPublicPackage();
  const event = fixture(BASE_EVENT_PATH);
  const consumer = newConsumer(api);
  const result = consumer.ingest(event);
  assert.equal(result.disposition, "accepted_untrusted");
  const observation = assertUntrustedObservation(result, event, BASE_SCOPE);
  assert.equal(observation.finding.attributes.canonical_source_capture_required, true);
  assert.ok(jsonHas(observation, event.payload.submitted_evidence[0].excerpt));
});

test("keeps transport event dedupe distinct from semantic candidate dedupe", async () => {
  const api = await loadPublicPackage();
  const event = fixture(BASE_EVENT_PATH);
  const consumer = newConsumer(api);

  const first = consumer.ingest(event);
  assert.equal(first.disposition, "accepted_untrusted");
  assertUntrustedObservation(first, event, BASE_SCOPE);

  const replay = clone(event);
  replay.attempt = 2;
  const transportDuplicate = consumer.ingest(replay);
  assert.equal(transportDuplicate.disposition, "transport_duplicate");
  assert.equal(transportDuplicate.observation, null);

  const secondEvent = clone(event);
  secondEvent.event_id = "event_rewards_monitor_m4_semantic_duplicate";
  const semanticDuplicate = consumer.ingest(secondEvent);
  assert.equal(semanticDuplicate.disposition, "semantic_duplicate");
  assert.equal(semanticDuplicate.semantic_key, first.semantic_key);
  assertUntrustedObservation(semanticDuplicate, secondEvent, BASE_SCOPE);
  assert.equal(consumer.transport_event_count, 2);
  assert.equal(consumer.semantic_key_count, 1);
  assert.equal(consumer.observation_count, 2);
});

test("fails closed when a producer reuses an event id with changed immutable content", async () => {
  const api = await loadPublicPackage();
  const event = fixture(BASE_EVENT_PATH);
  const consumer = newConsumer(api);
  consumer.ingest(event);

  const conflicting = clone(event);
  conflicting.attempt = 2;
  conflicting.payload.finding.summary = "hostile payload drift must not appear in an error";
  assert.throws(
    () => consumer.ingest(conflicting),
    (error) => {
      assert.equal(error?.code, "transport_payload_conflict");
      assert.equal(error?.message.includes("hostile payload drift"), false);
      return true;
    },
  );
  assert.equal(consumer.transport_event_count, 1);
  assert.equal(consumer.observation_count, 1);
});

test("keeps tenant and stream scope from collapsing into one semantic candidate", async () => {
  const api = await loadPublicPackage();
  const event = fixture(BASE_EVENT_PATH);
  const consumerA = newConsumer(api, BASE_SCOPE);
  const tenantB = {
    ...BASE_SCOPE,
    tenant_id: "tenant_m4_other",
  };
  const consumerB = newConsumer(api, tenantB);

  const tenantAResult = consumerA.ingest(event);
  const tenantBResult = consumerB.ingest(event);
  assert.equal(tenantAResult.disposition, "accepted_untrusted");
  assert.equal(tenantBResult.disposition, "accepted_untrusted");
  assertUntrustedObservation(tenantAResult, event, BASE_SCOPE);
  assertUntrustedObservation(tenantBResult, event, tenantB);

  const otherStream = clone(event);
  otherStream.event_id = "event_rewards_monitor_m4_other_stream";
  otherStream.stream_id = "rewards-optimizer.secondary-monitor";
  const streamResult = consumerA.ingest(otherStream);
  assert.equal(streamResult.disposition, "accepted_untrusted", "stream scope must not reuse a candidate from another stream");
  assert.notEqual(streamResult.semantic_key, tenantAResult.semantic_key);
  assertUntrustedObservation(streamResult, otherStream, BASE_SCOPE);

});

test("keeps authenticated consumer scope in transport and semantic identity", async () => {
  const api = await loadPublicPackage();
  const event = fixture(BASE_EVENT_PATH);
  const otherConsumerScope = {
    ...BASE_SCOPE,
    consumer_id: "consumer_m4_other",
  };
  const first = newConsumer(api, BASE_SCOPE).ingest(event);
  const second = newConsumer(api, otherConsumerScope).ingest(event);
  assertUntrustedObservation(first, event, BASE_SCOPE);
  assertUntrustedObservation(second, event, otherConsumerScope);
  assert.notEqual(first.semantic_key, second.semantic_key);
  assert.notEqual(first.observation.source_observation_id, second.observation.source_observation_id);
});

test("does not collapse changed generic claim content into one semantic candidate", async () => {
  const api = await loadPublicPackage();
  const event = fixture(BASE_EVENT_PATH);
  const changed = clone(event);
  changed.event_id = "event_m4_changed_claim";
  changed.payload.finding.summary = "A materially different proposition.";
  const consumer = newConsumer(api);
  const first = consumer.ingest(event);
  const second = consumer.ingest(changed);
  assert.equal(first.disposition, "accepted_untrusted");
  assert.equal(second.disposition, "accepted_untrusted");
  assert.notEqual(first.semantic_key, second.semantic_key);
});

test("retains hostile text and security flags as flagged untrusted content", async () => {
  const api = await loadPublicPackage();
  const event = hostileDeliveryEvent();
  const scope = {
    tenant_id: "tenant_m4_security",
    consumer_id: "consumer_m4_security",
    allowed_stream_ids: [event.stream_id],
  };
  const consumer = newConsumer(api, scope);
  const result = consumer.ingest(event);
  assert.equal(result.disposition, "accepted_untrusted");
  const observation = assertUntrustedObservation(result, event, scope);
  assert.deepEqual(observation.finding.security_flags, ["embedded_instruction", "attempted_authority_escalation"]);
  assert.ok(jsonHas(observation, "Ignore previous instructions."));
  assert.ok(jsonHas(observation, "publish automatically"));
  assertNoForbiddenDomainOutput(observation);
});

test("preserves unknown finding attributes as untrusted data", async () => {
  const api = await loadPublicPackage();
  const event = fixture(BASE_EVENT_PATH);
  event.event_id = "event_m4_unknown_attribute";
  event.payload.finding.attributes.future_extension = {
    kind: "not_interpreted",
    instruction_like_text: "publish this automatically",
  };

  const result = newConsumer(api).ingest(event);
  const observation = assertUntrustedObservation(result, event, BASE_SCOPE);
  assert.deepEqual(
    observation.finding.attributes.future_extension,
    event.payload.finding.attributes.future_extension,
  );
  assert.equal(observation.promotion_status, "not_promoted");
});

test("does not synthesize observations for lifecycle events", async () => {
  const api = await loadPublicPackage();
  const event = fixture(BASE_EVENT_PATH);
  const lifecycle = clone(event);
  lifecycle.event_id = "event_m4_lifecycle_only";
  lifecycle.event_type = "run.completed";
  lifecycle.finding_id = null;
  lifecycle.payload = {};
  const consumer = newConsumer(api);
  const result = consumer.ingest(lifecycle);
  assert.equal(result.disposition, "ignored_event");
  assert.equal(result.observation, null);
  assertNoForbiddenDomainOutput(result);
});
