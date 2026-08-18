import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { BoundCursorCodec } from "../../packages/delivery-core/src/index.ts";
import { canonicalJson, signRawBody, verifyRawBody } from "../../packages/protocol-runtime/src/index.ts";
import {
  PostgresAgentFeedPersistence,
  PostgresDeliveryRepository,
  appendOutboxEventInTransaction,
  createAgentFeedPool,
  migrateAgentFeed,
  payloadHash,
} from "../../packages/persistence-postgres/src/index.ts";
import type { DeliveryEvent } from "../../packages/persistence-postgres/src/index.ts";

const databaseUrl = process.env.AGENT_FEED_DATABASE_URL;
const CURSOR_NOW_SECONDS = 1_000;
const CURSOR_SECRET = "m2-conformance-cursor-secret";

function fixtureId(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll("-", "")}`;
}

function cursorCodec(): BoundCursorCodec {
  return new BoundCursorCodec({
    canonicalize: (payload) => canonicalJson(payload),
    signer: {
      sign: (payload) => signRawBody(payload, 0, CURSOR_SECRET),
      verify: (payload, signature) => verifyRawBody(payload, 0, signature, CURSOR_SECRET, { nowSeconds: 0 }),
    },
    nowSeconds: () => CURSOR_NOW_SECONDS,
  });
}

function deliveryRepository(pool: ReturnType<typeof createAgentFeedPool>): PostgresDeliveryRepository {
  return new PostgresDeliveryRepository(pool, {
    cursorCodec: cursorCodec(),
    cursorTtlSeconds: 900,
    nowSeconds: () => CURSOR_NOW_SECONDS,
  });
}

function beginInput(tenantId: string, streamId: string, runId = randomUUID()) {
  return {
    protocol_version: "0.1" as const,
    tenant_id: tenantId,
    idempotency_key: fixtureId("begin"),
    stream_id: streamId,
    producer: { producer_id: fixtureId("producer"), type: "automation", name: "m2-conformance", version: "1" },
    task: { task_type: "m2-conformance", definition_id: null, definition_version: null },
    expected_scope: { source_ids: [], subjects: [], queries: [], metadata: {} },
    started_at: "2026-08-18T00:00:00.000Z",
    parent_run_id: null,
    metadata: {},
    run_id: runId,
  };
}

function deliveryEvent(
  tenantId: string,
  runId: string,
  streamId: string,
  eventId = fixtureId("event"),
  traceId = fixtureId("trace"),
): DeliveryEvent {
  const findingId = fixtureId("finding");
  const payload = { finding: { finding_id: findingId, finding_type: "monitor.change", routing_tags: ["important", "japan"] } };
  return {
    protocolVersion: "0.1",
    eventId,
    eventType: "finding.submitted",
    tenantId,
    streamId,
    runId,
    findingId,
    occurredAt: "2026-08-18T00:00:01.000Z",
    sequence: "1",
    traceId,
    payload,
    payloadHash: payloadHash(payload),
    findingType: "monitor.change",
    routingTags: ["important", "japan"],
    deliveryEligible: true,
  };
}

function pullSubscription(tenantId: string, consumerId: string, streamId: string) {
  return {
    tenantId,
    consumerId,
    streamIds: [streamId],
    // These live repository tests use synthetic outbox rows without a
    // database finding FK. Selector semantics are exercised against the real
    // delivery-core/consumer APIs; the durable tests focus on fan-out scope.
    findingTypes: null,
    routingTags: null,
    eventTypes: ["finding.submitted" as const],
    includeRunEvents: true,
    deliveryMode: "pull" as const,
  };
}

async function migrate(pool: ReturnType<typeof createAgentFeedPool>): Promise<void> {
  await migrateAgentFeed(pool);
}

async function databaseOperationClock(
  pool: ReturnType<typeof createAgentFeedPool>,
): Promise<(offsetSeconds: number) => string> {
  const result = await pool.query<{ now: Date }>("select clock_timestamp() as now");
  const epoch = new Date(result.rows[0]?.now ?? Date.now()).getTime() + 60_000;
  return (offsetSeconds: number): string =>
    new Date(epoch + offsetSeconds * 1_000).toISOString();
}

test("live PostgreSQL proves transactional outbox, tenant fan-out isolation, per-subscription acknowledgement, and immutable source state", {
  skip: databaseUrl ? false : "AGENT_FEED_DATABASE_URL is not set; live M2 PostgreSQL coverage is not a passing result",
}, async () => {
  const pool = createAgentFeedPool(databaseUrl);
  const suffix = fixtureId("live");
  const tenantA = `${suffix}_tenant_a`;
  const tenantB = `${suffix}_tenant_b`;
  const streamId = `${suffix}.stream`;
  const sharedEventId = `${suffix}_shared_event`;
  try {
    await migrate(pool);
    const operationTime = await databaseOperationClock(pool);
    const persistence = new PostgresAgentFeedPersistence(pool);
    const delivery = deliveryRepository(pool);
    const runA = await persistence.beginRun(beginInput(tenantA, streamId));
    const runB = await persistence.beginRun(beginInput(tenantB, streamId));
    const subscriptionA = await delivery.registerSubscription(pullSubscription(tenantA, "consumer_a", streamId));
    const subscriptionB = await delivery.registerSubscription(pullSubscription(tenantB, "consumer_b", streamId));

    // A transaction that fails after the outbox insert leaves neither row.
    const rollbackClient = await pool.connect();
    try {
      await rollbackClient.query("begin");
      await appendOutboxEventInTransaction(rollbackClient, deliveryEvent(tenantA, runA.run_id, streamId, `${suffix}_rollback`));
      await rollbackClient.query("rollback");
    } finally {
      rollbackClient.release();
    }
    const rolledBack = await pool.query<{ count: string }>(
      `select count(*)::text as count from agent_feed.outbox_events where tenant_id = $1 and event_id = $2`,
      [tenantA, `${suffix}_rollback`],
    );
    assert.equal(Number(rolledBack.rows[0]?.count), 0);

    // The same event ID is valid in two tenants, and each subscription gets a
    // separate durable delivery row through the real fan-out repository.
    await delivery.appendOutboxEvent(deliveryEvent(tenantA, runA.run_id, streamId, sharedEventId));
    await delivery.appendOutboxEvent(deliveryEvent(tenantB, runB.run_id, streamId, sharedEventId));
    const deliveryRows = await pool.query<{ tenant_id: string; count: string }>(
      `select tenant_id, count(*)::text as count
         from agent_feed.consumer_deliveries
        where event_id = $1 and tenant_id in ($2, $3)
        group by tenant_id order by tenant_id`,
      [sharedEventId, tenantA, tenantB],
    );
    assert.deepEqual(deliveryRows.rows.map((row) => [row.tenant_id, Number(row.count)]), [[tenantA, 1], [tenantB, 1]]);

    await assert.rejects(
      pool.query(
        `insert into agent_feed.consumer_deliveries
          (tenant_id, consumer_id, subscription_id, selector_version, event_id)
         values ($1, $2, $3, 1, $4)`,
        [tenantA, "consumer_a", subscriptionB.subscriptionId, sharedEventId],
      ),
      /foreign key|violates/i,
      "a tenant-A row cannot reference the tenant-B subscription",
    );

    const claimA = (await delivery.claimDue({
      now: operationTime(10), limit: 10, leaseDurationSeconds: 30,
      workerId: "worker-a", tenantId: tenantA, consumerId: "consumer_a",
    }))[0];
    const claimB = (await delivery.claimDue({
      now: operationTime(10), limit: 10, leaseDurationSeconds: 30,
      workerId: "worker-b", tenantId: tenantB, consumerId: "consumer_b",
    }))[0];
    assert.ok(claimA);
    assert.ok(claimB);
    assert.notEqual(claimA.job.deliveryId, claimB.job.deliveryId);
    assert.equal(claimA.event.eventId, claimB.event.eventId);

    const ackInput = (claim: NonNullable<typeof claimA>, tenantId: string, consumerId: string) => ({
      tenantId,
      consumerId,
      subscriptionId: claim.job.subscriptionId,
      deliveryId: claim.job.deliveryId,
      leaseToken: claim.job.leaseToken ?? "",
      attempt: claim.job.attempt,
      replayGeneration: claim.job.replayGeneration,
      now: operationTime(11),
      status: 204,
    });
    const acknowledgedA = await delivery.acknowledge(ackInput(claimA, tenantA, "consumer_a"));
    const acknowledgedB = await delivery.acknowledge(ackInput(claimB, tenantB, "consumer_b"));
    assert.equal(acknowledgedA.applied, true);
    assert.equal(acknowledgedB.applied, true);
    const duplicateAck = await delivery.acknowledge(ackInput(claimA, tenantA, "consumer_a"));
    assert.deepEqual(duplicateAck.applied, false);
    assert.equal(duplicateAck.reason, "already_terminal");

    const acknowledgementRows = await pool.query<{ count: string }>(
      `select count(*)::text as count from agent_feed.acknowledgements where event_id = $1`,
      [sharedEventId],
    );
    assert.equal(Number(acknowledgementRows.rows[0]?.count), 2);

    const outboxState = await pool.query<{ delivered_at: Date | null }>(
      `select delivered_at from agent_feed.outbox_events where tenant_id = $1 and event_id = $2`,
      [tenantA, sharedEventId],
    );
    assert.equal(outboxState.rows[0]?.delivered_at, null, "outbox delivered_at is not an acknowledgement state");
    await assert.rejects(
      pool.query(`update agent_feed.outbox_events set delivered_at = now() where tenant_id = $1 and event_id = $2`, [tenantA, sharedEventId]),
      /immutable/i,
    );
  } finally {
    await pool.end();
  }
});

test("live PostgreSQL leases exclude concurrent workers, recover crashes, persist retry state, and replay DLQ idempotently", {
  skip: databaseUrl ? false : "AGENT_FEED_DATABASE_URL is not set; live lease/retry/replay coverage is not a passing result",
}, async () => {
  const pool = createAgentFeedPool(databaseUrl);
  const suffix = fixtureId("lease");
  const tenantId = `${suffix}_tenant`;
  const streamId = `${suffix}.stream`;
  try {
    await migrate(pool);
    const operationTime = await databaseOperationClock(pool);
    const delivery = deliveryRepository(pool);
    const runId = randomUUID();
    const subscription = await delivery.registerSubscription(pullSubscription(tenantId, "consumer", streamId));
    await pool.query(
      `insert into agent_feed.runs
        (id, tenant_id, stream_id, producer_id, begin_idempotency_key, begin_payload_hash, status, envelope, started_at)
       values ($1, $2, $3, $4, $5, $6, 'running', $7::jsonb, $8)`,
      [runId, tenantId, streamId, fixtureId("producer"), fixtureId("begin"), fixtureId("hash"), JSON.stringify({ run_id: runId, stream_id: streamId, protocol_version: "0.1" }), "2026-08-18T00:00:00.000Z"],
    );
    const event = deliveryEvent(tenantId, runId, streamId);
    await delivery.appendOutboxEvent(event);

    const first = (await delivery.claimDue({
      now: operationTime(10), limit: 1, leaseDurationSeconds: 30,
      workerId: "worker-crashed", tenantId, consumerId: "consumer",
    }))[0];
    assert.ok(first);
    assert.equal(first.job.attempt, 1);
    const concurrent = await delivery.claimDue({
      now: operationTime(20), limit: 1, leaseDurationSeconds: 30,
      workerId: "worker-live", tenantId, consumerId: "consumer",
    });
    assert.equal(concurrent.length, 0, "SKIP LOCKED/lease state excludes a concurrent worker");

    // Recovery is a global queue sweep, so a shared disposable database may
    // contain stale leases from another fixture. Verify the result for this
    // delivery rather than treating unrelated tenants as a failure.
    assert.ok(await delivery.recoverExpiredLeases({ now: operationTime(41), limit: 10 }) >= 1);
    const recoveredRow = await pool.query<{ state: string }>(
      `select state from agent_feed.consumer_deliveries where tenant_id = $1 and id = $2::uuid`,
      [tenantId, first.job.deliveryId],
    );
    assert.equal(recoveredRow.rows[0]?.state, "retry_wait");
    const reclaimed = (await delivery.claimDue({
      now: operationTime(41), limit: 1, leaseDurationSeconds: 30,
      workerId: "worker-live", tenantId, consumerId: "consumer",
    }))[0];
    assert.ok(reclaimed);
    assert.equal(reclaimed.job.attempt, 2);
    const staleAck = await delivery.acknowledge({
      tenantId, consumerId: "consumer", subscriptionId: subscription.subscriptionId,
      deliveryId: first.job.deliveryId, leaseToken: first.job.leaseToken ?? "",
      attempt: first.job.attempt, replayGeneration: first.job.replayGeneration,
      now: operationTime(41), status: 204,
    });
    assert.equal(staleAck.applied, false);
    assert.equal(staleAck.reason, "stale_lease");
    assert.equal(staleAck.job?.deliveryId, reclaimed.job.deliveryId);
    assert.equal(staleAck.job?.attempt, reclaimed.job.attempt);

    const retry = await delivery.scheduleRetry({
      tenantId, consumerId: "consumer", subscriptionId: subscription.subscriptionId,
      deliveryId: reclaimed.job.deliveryId, leaseToken: reclaimed.job.leaseToken ?? "",
      attempt: reclaimed.job.attempt, replayGeneration: reclaimed.job.replayGeneration,
      now: operationTime(42), nextAttemptAt: operationTime(60),
      error: { code: "timeout", message: "synthetic outage", retryable: true, status: null },
    });
    assert.equal(retry.applied, true);
    assert.equal((await delivery.claimDue({
      now: operationTime(59), limit: 1, leaseDurationSeconds: 30,
      workerId: "worker-live", tenantId, consumerId: "consumer",
    })).length, 0);

    const attemptThree = (await delivery.claimDue({
      now: operationTime(60), limit: 1, leaseDurationSeconds: 30,
      workerId: "worker-live", tenantId, consumerId: "consumer",
    }))[0];
    assert.ok(attemptThree);
    assert.equal(attemptThree.job.attempt, 3);
    const dead = await delivery.deadLetter({
      tenantId, consumerId: "consumer", subscriptionId: subscription.subscriptionId,
      deliveryId: attemptThree.job.deliveryId, leaseToken: attemptThree.job.leaseToken ?? "",
      attempt: attemptThree.job.attempt, replayGeneration: attemptThree.job.replayGeneration,
      now: operationTime(61), error: { code: "permanent", message: "synthetic permanent failure", retryable: false, status: 400 },
    });
    assert.equal(dead.applied, true);
    const replayInput = {
      tenantId, consumerId: "consumer", subscriptionId: subscription.subscriptionId,
      deliveryId: attemptThree.job.deliveryId, requestedAt: operationTime(62),
      reason: "M2 deterministic replay", idempotencyKey: fixtureId("replay_key"), payloadHash: "replay-body-v1",
    };
    const replayOne = await delivery.replay(replayInput);
    const replayTwo = await delivery.replay(replayInput);
    assert.equal(replayOne.eventId, event.eventId);
    assert.equal(replayOne.replayGeneration, 1);
    assert.deepEqual(replayTwo, replayOne);

    const replayClaim = (await delivery.claimDue({
      now: operationTime(62), limit: 1, leaseDurationSeconds: 30,
      workerId: "worker-live", tenantId, consumerId: "consumer",
    }))[0];
    assert.ok(replayClaim);
    assert.equal(replayClaim.job.attempt, 4);
    assert.equal(replayClaim.event.eventId, event.eventId);
    const finalAck = await delivery.acknowledge({
      tenantId, consumerId: "consumer", subscriptionId: subscription.subscriptionId,
      deliveryId: replayClaim.job.deliveryId, leaseToken: replayClaim.job.leaseToken ?? "",
      attempt: replayClaim.job.attempt, replayGeneration: replayClaim.job.replayGeneration,
      now: operationTime(63), status: 204,
    });
    assert.equal(finalAck.applied, true);

    const attempts = await pool.query<{ attempt_number: number; attempt_kind: string; state: string }>(
      `select attempt_number, attempt_kind, state from agent_feed.delivery_attempts
        where tenant_id = $1 and delivery_id = $2::uuid order by attempt_number`,
      [tenantId, first.job.deliveryId],
    );
    assert.deepEqual(attempts.rows.map((row) => [Number(row.attempt_number), row.attempt_kind, row.state]), [
      [1, "initial", "expired"],
      [2, "retry", "failed"],
      [3, "retry", "dead_lettered"],
      [4, "replay", "succeeded"],
    ]);
  } finally {
    await pool.end();
  }
});

test("live PostgreSQL pull cursors reject cross-subscription and tampered tokens", {
  skip: databaseUrl ? false : "AGENT_FEED_DATABASE_URL is not set; live pull cursor coverage is not a passing result",
}, async () => {
  const pool = createAgentFeedPool(databaseUrl);
  const suffix = fixtureId("cursor");
  const tenantId = `${suffix}_tenant`;
  const streamId = `${suffix}.stream`;
  try {
    await migrate(pool);
    const operationTime = await databaseOperationClock(pool);
    const delivery = deliveryRepository(pool);
    const runId = randomUUID();
    const subscriptionA = await delivery.registerSubscription(pullSubscription(tenantId, "consumer_a", streamId));
    const subscriptionB = await delivery.registerSubscription(pullSubscription(tenantId, "consumer_b", streamId));
    await pool.query(
      `insert into agent_feed.runs
        (id, tenant_id, stream_id, producer_id, begin_idempotency_key, begin_payload_hash, status, envelope, started_at)
       values ($1, $2, $3, $4, $5, $6, 'running', $7::jsonb, $8)`,
      [runId, tenantId, streamId, fixtureId("producer"), fixtureId("begin"), fixtureId("hash"), JSON.stringify({ run_id: runId, stream_id: streamId, protocol_version: "0.1" }), "2026-08-18T00:00:00.000Z"],
    );
    await delivery.appendOutboxEvent(deliveryEvent(tenantId, runId, streamId));
    await delivery.appendOutboxEvent(deliveryEvent(tenantId, runId, streamId));

    const firstPage = await delivery.pull({
      tenantId, consumerId: "consumer_a", subscriptionId: subscriptionA.subscriptionId,
      selectorVersion: subscriptionA.selectorVersion, cursor: null, limit: 1,
      now: operationTime(60),
    });
    assert.equal(firstPage.deliveries.length, 1);
    assert.ok(firstPage.nextCursor, "two events must produce a continuation cursor");
    const secondPage = await delivery.pull({
      tenantId, consumerId: "consumer_a", subscriptionId: subscriptionA.subscriptionId,
      selectorVersion: subscriptionA.selectorVersion, cursor: firstPage.nextCursor, limit: 1,
      now: operationTime(60),
    });
    assert.equal(secondPage.deliveries.length, 1);

    // A cursor is scoped to tenant/consumer/subscription and selector version;
    // a base64 token with no authenticated scope is not an acceptable cursor.
    await assert.rejects(
      delivery.pull({
        tenantId, consumerId: "consumer_b", subscriptionId: subscriptionB.subscriptionId,
        selectorVersion: subscriptionB.selectorVersion, cursor: firstPage.nextCursor, limit: 1,
        now: operationTime(60),
      }),
      /cursor|scope|invalid/i,
    );
    const token = firstPage.nextCursor!;
    const [encodedPayload, signature] = token.split(".");
    assert.ok(encodedPayload);
    assert.ok(signature);
    const decoded = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8")) as Record<string, unknown>;
    decoded.position = "0";
    const tampered = `${Buffer.from(canonicalJson(decoded), "utf8").toString("base64url")}.${signature}`;
    await assert.rejects(
      delivery.pull({
        tenantId, consumerId: "consumer_a", subscriptionId: subscriptionA.subscriptionId,
        selectorVersion: subscriptionA.selectorVersion, cursor: tampered, limit: 1,
        now: operationTime(60),
      }),
      /cursor|scope|invalid/i,
    );
  } finally {
    await pool.end();
  }
});
