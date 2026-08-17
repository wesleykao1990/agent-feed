import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { BoundCursorCodec } from "@agent-feed/delivery-core";
import { canonicalJson, signRawBody, verifyRawBody } from "@agent-feed/protocol-runtime";
import {
  PostgresAgentFeedPersistence,
  PostgresDeliveryRepository,
  createAgentFeedPool,
  migrateAgentFeed,
  payloadHash,
} from "../src/index.ts";
import type { BeginRunRequest, CompleteRunRequest, DeliveryEvent, EvidencePayload, FindingPayload, SubmitBatchRequest } from "../src/index.ts";

const databaseUrl = process.env.AGENT_FEED_DATABASE_URL;

function begin(tenantId: string, streamId: string): BeginRunRequest {
  return {
    protocol_version: "0.1",
    tenant_id: tenantId,
    idempotency_key: `begin-${randomUUID()}`,
    stream_id: streamId,
    producer: { producer_id: `delivery-test-${tenantId}`, type: "automation", name: "delivery-test", version: "1" },
    task: { task_type: "delivery-regression", definition_id: null, definition_version: null },
    expected_scope: { source_ids: [], subjects: [], queries: [], metadata: {} },
    started_at: "2026-08-18T00:00:00.000Z",
    parent_run_id: null,
    metadata: {},
    run_id: randomUUID(),
  };
}

function evidence(id: string): EvidencePayload {
  return {
    evidence_id: id, kind: "web", source: { uri: "https://example.invalid", title: "synthetic" },
    captured_at: "2026-08-18T00:00:00.000Z", published_at: null, locator: null,
    excerpt: "synthetic", content_hash: null, artifact: {},
    handling: { contains_personal_data: false, contains_secrets: false, redistribution_restricted: false }, metadata: {},
  };
}

function finding(id: string, evidenceId: string): FindingPayload {
  return {
    finding_id: id, finding_type: "delivery.synthetic", title: "Synthetic", summary: "Synthetic finding",
    subjects: [], evidence_refs: [evidenceId], security_flags: [],
    routing_tags: ["alpha", "beta"],
  } as FindingPayload;
}

test("Postgres delivery repository claims, scopes, acknowledges, and replays durable events", { skip: databaseUrl ? false : "AGENT_FEED_DATABASE_URL is not set" }, async () => {
  const pool = createAgentFeedPool(databaseUrl);
  try {
    await migrateAgentFeed(pool);
    const persistence = new PostgresAgentFeedPersistence(pool);
    let cursorNow = 1_000;
    const cursorCodec = new BoundCursorCodec({
      canonicalize: (payload) => canonicalJson(payload),
      signer: {
        sign: (payload) => signRawBody(payload, 0, "delivery-cursor-test-secret"),
        verify: (payload, signature) => verifyRawBody(payload, 0, signature, "delivery-cursor-test-secret", { nowSeconds: 0 }),
      },
      nowSeconds: () => cursorNow,
    });
    const delivery = new PostgresDeliveryRepository(pool, { cursorCodec, cursorTtlSeconds: 60, nowSeconds: () => cursorNow });
    const tenantId = `delivery-test-${randomUUID()}`;
    const streamId = `delivery.stream.${randomUUID()}`;
    await assert.rejects(
      delivery.registerSubscription({ tenantId, consumerId: "consumer-empty", streamIds: [], deliveryMode: "pull" }),
      /stream_ids_must_not_be_empty/,
    );

    const sharedStream = `delivery.shared.${randomUUID()}`;
    const sharedKey = `shared-begin-${randomUUID()}`;
    const sharedA = begin(`${tenantId}-a`, sharedStream);
    const sharedAWithKey = {
      ...sharedA,
      idempotency_key: sharedKey,
      run_id: randomUUID(),
      producer: { ...sharedA.producer, producer_id: "same-producer" },
    };
    const sharedB = {
      ...sharedAWithKey,
      tenant_id: `${tenantId}-b`,
      run_id: randomUUID(),
    };
    const sharedRunA = await persistence.beginRun(sharedAWithKey);
    const sharedRunB = await persistence.beginRun(sharedB);
    assert.notEqual(sharedRunA.run_id, sharedRunB.run_id, "begin idempotency is tenant-scoped");
    const subscription = await delivery.registerSubscription({
      tenantId, consumerId: "consumer-a", streamIds: [streamId],
      findingTypes: ["delivery.synthetic"],
      routingTags: { mode: "all", values: ["alpha", "beta"] },
      eventTypes: ["finding.submitted"],
      includeRunEvents: true, deliveryMode: "pull",
    });

    const started = await persistence.beginRun(begin(tenantId, streamId));
    const startedEvent: DeliveryEvent = {
      protocolVersion: "0.1", eventId: `evt_${started.run_id}_started`, eventType: "run.started",
      tenantId, streamId, runId: started.run_id, findingId: null,
      occurredAt: started.started_at, sequence: "0", traceId: started.trace_id,
      payload: started.envelope as unknown as DeliveryEvent["payload"],
      payloadHash: payloadHash(started.envelope as unknown as Record<string, unknown>),
      findingType: null, routingTags: [], deliveryEligible: true,
    };
    await assert.rejects(
      delivery.appendOutboxEvent({ ...startedEvent, eventType: "run.failed" }),
      /outbox_event_idempotency_conflict/,
      "same event key cannot silently accept changed immutable content",
    );
    await assert.rejects(
      delivery.appendOutboxEvent({ ...startedEvent, payloadHash: "caller-supplied-wrong-hash" }),
      /outbox_event_payload_hash_mismatch/,
      "ingress must not trust a caller-supplied payload hash",
    );
    const startedRows = await pool.query<{ count: string }>(
      `select count(*)::text as count from agent_feed.consumer_deliveries
        where tenant_id = $1 and consumer_id = 'consumer-a' and subscription_id = $2`,
      [tenantId, subscription.subscriptionId],
    );
    assert.equal(Number(startedRows.rows[0]?.count), 0, "event-type selector excludes run.started; finding selectors do not apply to lifecycle events");

    const batch: SubmitBatchRequest = {
      protocol_version: "0.1", tenant_id: tenantId, run_id: started.run_id,
      batch_id: `batch-${randomUUID()}`, idempotency_key: `batch-${randomUUID()}`,
      sequence_number: 1, submitted_at: "2026-08-18T00:00:01.000Z",
      findings: [finding(`finding-${randomUUID()}`, "evidence-1")], evidence: [evidence("evidence-1")], metadata: {},
    };
    await persistence.submitBatch(batch);
    const findingOutbox = await pool.query<{ payload: { submitted_evidence?: unknown[] } }>(
      `select payload from agent_feed.outbox_events where tenant_id = $1 and event_type = 'finding.submitted' and wire_run_id = $2`,
      [tenantId, started.run_id],
    );
    assert.deepEqual(findingOutbox.rows[0]?.payload.submitted_evidence?.[0], batch.evidence[0], "finding events preserve full evidence payloads");
    const claims = await delivery.claimDue({ now: "2026-08-18T00:00:02.000Z", limit: 10, leaseDurationSeconds: 30, workerId: "worker-a", tenantId, consumerId: "consumer-a" });
    assert.equal(claims.length, 1);
    const claim = claims[0];
    assert.ok(claim);
    assert.equal(claim.event.eventType, "finding.submitted");
    assert.equal(claim.event.routingTags.length, 2);
    const acknowledged = await delivery.acknowledge({
      tenantId, consumerId: "consumer-a", subscriptionId: subscription.subscriptionId,
      deliveryId: claim.job.deliveryId, leaseToken: claim.job.leaseToken ?? "",
      attempt: claim.job.attempt, replayGeneration: claim.job.replayGeneration,
      now: "2026-08-18T00:00:03.000Z", status: 204,
    });
    assert.equal(acknowledged.applied, true);

    const unsafeRun = await persistence.beginRun({ ...begin(tenantId, streamId), idempotency_key: `begin-unsafe-${randomUUID()}` });
    const unsafeEvidence = { ...evidence(`unsafe-evidence-${randomUUID()}`), handling: { contains_personal_data: true, contains_secrets: false, redistribution_restricted: false } };
    const unsafeFinding = finding(`unsafe-finding-${randomUUID()}`, unsafeEvidence.evidence_id);
    await persistence.submitBatch({
      protocol_version: "0.1", tenant_id: tenantId, run_id: unsafeRun.run_id,
      batch_id: `batch-unsafe-${randomUUID()}`, idempotency_key: `batch-unsafe-${randomUUID()}`,
      sequence_number: 1, submitted_at: "2026-08-18T00:00:03.500Z",
      findings: [unsafeFinding], evidence: [unsafeEvidence], metadata: {},
    });
    const unsafeOutbox = await pool.query<{ event_id: string; delivery_eligibility: string }>(
      `select event_id, delivery_eligibility
         from agent_feed.outbox_events
        where tenant_id = $1 and event_type = 'finding.submitted' and wire_run_id = $2`,
      [tenantId, unsafeRun.run_id],
    );
    assert.equal(unsafeOutbox.rows[0]?.delivery_eligibility, "quarantined", "unsafe evidence must quarantine its finding event");
    const unsafeDeliveries = await pool.query<{ count: string }>(
      `select count(*)::text as count
         from agent_feed.consumer_deliveries
        where tenant_id = $1 and event_id = $2`,
      [tenantId, unsafeOutbox.rows[0]?.event_id],
    );
    assert.equal(Number(unsafeDeliveries.rows[0]?.count), 0, "quarantined evidence must not be fanned out");

    const secondRun = await persistence.beginRun({ ...begin(tenantId, streamId), idempotency_key: `begin-${randomUUID()}` });
    const secondClaim = (await delivery.claimDue({ now: "2026-08-18T00:00:04.000Z", limit: 10, leaseDurationSeconds: 30, workerId: "worker-a", tenantId, consumerId: "consumer-a" }))[0];
    assert.equal(secondClaim, undefined, "run.started remains excluded by finding selector");
    assert.notEqual(secondRun.run_id, started.run_id);

    const terminalSubscription = await delivery.registerSubscription({
      tenantId, consumerId: "consumer-a", streamIds: [streamId], findingTypes: null,
      eventTypes: ["run.completed"], includeRunEvents: true, deliveryMode: "pull",
    });

    const terminal = {
      protocol_version: "0.1", tenant_id: tenantId, run_id: started.run_id,
      idempotency_key: `complete-${randomUUID()}`, status: "completed", completed_at: "2026-08-18T00:01:00.000Z",
      actual_scope: { source_ids: [], subjects: [], queries: [], metadata: {} },
      stats: { sources_attempted: 1, sources_succeeded: 1, findings_submitted: 1, evidence_submitted: 1, batches_submitted: 1 },
      errors: [], metadata: {},
    } satisfies CompleteRunRequest;
    await persistence.completeRun(terminal);
    const terminal2 = {
      ...terminal,
      run_id: secondRun.run_id,
      idempotency_key: `complete-${randomUUID()}`,
      stats: { sources_attempted: 1, sources_succeeded: 1, findings_submitted: 0, evidence_submitted: 0, batches_submitted: 0 },
    } satisfies CompleteRunRequest;
    await persistence.completeRun(terminal2);
    const pull = await delivery.pull({ tenantId, consumerId: "consumer-a", subscriptionId: terminalSubscription.subscriptionId, selectorVersion: terminalSubscription.selectorVersion, cursor: null, limit: 1, now: "2026-08-18T00:02:00.000Z" });
    assert.equal(pull.deliveries.length, 1, "terminal subscription receives the terminal event");
    assert.equal(pull.deliveries[0]?.event?.eventType, "run.completed");
    assert.ok(pull.nextCursor);
    const validCursor = pull.nextCursor;
    await assert.rejects(
      delivery.pull({ tenantId, consumerId: "consumer-a", subscriptionId: terminalSubscription.subscriptionId, selectorVersion: terminalSubscription.selectorVersion, cursor: `${validCursor.slice(0, -1)}x`, limit: 1, now: "2026-08-18T00:02:00.000Z" }),
      /cursor_signature_mismatch|invalid_cursor/,
    );
    await assert.rejects(
      delivery.pull({ tenantId, consumerId: "consumer-b", subscriptionId: terminalSubscription.subscriptionId, selectorVersion: terminalSubscription.selectorVersion, cursor: validCursor, limit: 1, now: "2026-08-18T00:02:00.000Z" }),
      /cursor_scope_mismatch/,
    );
    cursorNow = 1_060;
    await assert.rejects(
      delivery.pull({ tenantId, consumerId: "consumer-a", subscriptionId: terminalSubscription.subscriptionId, selectorVersion: terminalSubscription.selectorVersion, cursor: validCursor, limit: 1, now: "2026-08-18T00:02:00.000Z" }),
      /cursor_expired/,
    );

    const dead = await delivery.claimDue({ now: "2026-08-18T00:02:01.000Z", limit: 1, leaseDurationSeconds: 30, workerId: "worker-a", tenantId, consumerId: "consumer-a" });
    const deadClaim = dead[0];
    assert.ok(deadClaim);
    const deadLettered = await delivery.deadLetter({
      tenantId, consumerId: "consumer-a", subscriptionId: terminalSubscription.subscriptionId,
      deliveryId: deadClaim.job.deliveryId, leaseToken: deadClaim.job.leaseToken ?? "",
      attempt: deadClaim.job.attempt, replayGeneration: deadClaim.job.replayGeneration,
      now: "2026-08-18T00:02:02.000Z", error: {
        code: "permanent", message: "secret=https://private.example/token", retryable: false, status: 400,
      },
    });
    assert.equal(deadLettered.applied, true);
    const redactedError = await pool.query<{ last_error_detail: string; dead_letter_reason: string }>(
      `select last_error_detail, dead_letter_reason
         from agent_feed.consumer_deliveries
        where tenant_id = $1 and id = $2::uuid`,
      [tenantId, deadClaim.job.deliveryId],
    );
    assert.equal(redactedError.rows[0]?.last_error_detail, "delivery attempt failed");
    assert.equal(redactedError.rows[0]?.dead_letter_reason, "permanent");
    assert.doesNotMatch(JSON.stringify(redactedError.rows[0]), /private\.example|token/u);
    const replayed = await delivery.replay({
      tenantId, consumerId: "consumer-a", subscriptionId: terminalSubscription.subscriptionId,
      deliveryId: deadClaim.job.deliveryId, requestedAt: "2026-08-18T00:02:03.000Z",
      reason: "regression test", idempotencyKey: `replay-${randomUUID()}`, payloadHash: "replay-request-v1",
    });
    assert.equal(replayed.state, "queued");
    assert.equal(replayed.replayGeneration, 1);
  } finally {
    await pool.end();
  }
});
