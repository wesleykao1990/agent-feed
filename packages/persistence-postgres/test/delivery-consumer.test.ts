import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { BoundCursorCodec } from "@agent-feed/delivery-core";
import { canonicalJson, signRawBody, verifyRawBody } from "@agent-feed/protocol-runtime";
import { DeliveryConsumerService } from "@agent-feed/delivery-consumer";
import {
  PostgresAgentFeedPersistence,
  PostgresDeliveryConsumerRepository,
  createAgentFeedPool,
  migrateAgentFeed,
  payloadHash,
} from "../src/index.ts";
import type { BeginRunRequest, CompleteRunRequest } from "../src/index.ts";

const databaseUrl = process.env.AGENT_FEED_DATABASE_URL;

function begin(tenantId: string, streamId: string): BeginRunRequest {
  return {
    protocol_version: "0.1",
    tenant_id: tenantId,
    idempotency_key: `consumer-begin-${randomUUID()}`,
    stream_id: streamId,
    producer: { producer_id: `consumer-producer-${randomUUID()}`, type: "automation", name: "consumer-test", version: "1" },
    task: { task_type: "consumer-adapter", definition_id: null, definition_version: null },
    expected_scope: { source_ids: [], subjects: [], queries: [], metadata: {} },
    started_at: "2026-08-18T00:00:00.000Z",
    parent_run_id: null,
    metadata: {},
    run_id: randomUUID(),
  };
}

function complete(runId: string, tenantId: string, streamId: string): CompleteRunRequest {
  return {
    protocol_version: "0.1",
    tenant_id: tenantId,
    run_id: runId,
    idempotency_key: `consumer-complete-${randomUUID()}`,
    status: "completed",
    completed_at: "2026-08-18T00:00:01.000Z",
    actual_scope: { source_ids: [], subjects: [], queries: [], metadata: {} },
    stats: {
      sources_attempted: 0,
      sources_succeeded: 0,
      findings_submitted: 0,
      evidence_submitted: 0,
      batches_submitted: 0,
    },
    errors: [],
    metadata: { streamId },
  };
}

test(
  "Postgres consumer repository composes with DeliveryConsumerService for future selectors, pull ACK, and replay",
  { skip: databaseUrl ? false : "AGENT_FEED_DATABASE_URL is not set" },
  async () => {
    const pool = createAgentFeedPool(databaseUrl);
    try {
      await migrateAgentFeed(pool);
      const tenantId = `consumer-live-${randomUUID()}`;
      const consumerId = `consumer-${randomUUID()}`;
      const streamId = `stream.consumer.${randomUUID()}`;
      const repository = new PostgresDeliveryConsumerRepository(pool);
      const context = {
        tenantId,
        consumerId,
        allowedStreamIds: [streamId],
      };
      let nowSeconds = 10_000;
      const cursorCodec = new BoundCursorCodec({
        canonicalize: (claims) => canonicalJson(claims),
        signer: {
          sign: (body) => signRawBody(body, 0, "consumer-adapter-test-secret"),
          verify: (body, signature) => verifyRawBody(body, 0, signature, "consumer-adapter-test-secret", { nowSeconds: 0 }),
        },
        nowSeconds: () => nowSeconds,
      });
      const service = new DeliveryConsumerService({
        repository,
        auth: { getContext: () => structuredClone(context) },
        cursorCodec,
        payloadHasher: { hash: (value) => payloadHash(value as Record<string, unknown>) },
        nowSeconds: () => nowSeconds,
        cursorTtlSeconds: 60,
      });

      const created = await service.createSubscription({
        name: "consumer pull",
        selectors: {
          streamIds: [streamId],
          findingTypes: ["consumer.finding"],
          routingTags: { mode: "all", values: ["consumer-tag"] },
          eventTypes: ["run.started", "finding.submitted"],
        },
        delivery: { mode: "pull" },
      });
      assert.equal(created.selectorVersion, 1);
      assert.equal((await service.listSubscriptions()).length, 1);

      const persistence = new PostgresAgentFeedPersistence(pool);
      const run = await persistence.beginRun(begin(tenantId, streamId));
      const firstPage = await service.pullPage({ subscriptionId: created.id, limit: 10 });
      assert.equal(firstPage.items.length, 1);
      assert.equal(firstPage.items[0]?.event.eventType, "run.started");
      assert.equal(firstPage.items[0]?.status, "pending");

      const ackKey = `ack-${randomUUID()}`;
      const firstAck = await service.acknowledge({
        subscriptionId: created.id,
        deliveryIds: [firstPage.items[0]!.deliveryId],
        idempotencyKey: ackKey,
      });
      const repeatedAck = await service.acknowledge({
        subscriptionId: created.id,
        deliveryIds: [firstPage.items[0]!.deliveryId],
        idempotencyKey: ackKey,
      });
      assert.equal(firstAck.acknowledgedDeliveryIds.length, 1);
      assert.ok(firstAck.ackCursor);
      assert.equal(cursorCodec.decode(firstAck.ackCursor!).position, "1");
      assert.deepEqual(repeatedAck, firstAck);

      // A future selector update must not strand an already-materialized,
      // unacknowledged delivery from the previous selector version.
      await persistence.beginRun(begin(tenantId, streamId));
      const updated = await service.updateSubscription({
        subscriptionId: created.id,
        expectedSelectorVersion: 1,
        selectors: { streamIds: [streamId], eventTypes: ["run.completed"] },
      });
      assert.equal(updated.selectorVersion, 2);
      await persistence.completeRun(complete(run.run_id, tenantId, streamId));
      const secondPage = await service.pullPage({ subscriptionId: created.id, limit: 10 });
      assert.equal(secondPage.items.length, 2);
      assert.deepEqual(secondPage.items.map((item) => item.event.eventType), ["run.started", "run.completed"]);
      assert.ok(secondPage.ackCursor);
      assert.equal(cursorCodec.decode(secondPage.ackCursor!).position, "1", "ACK watermark must be contiguous, not MAX");

      const completedDelivery = secondPage.items.find((item) => item.event.eventType === "run.completed");
      assert.ok(completedDelivery);
      const deadDeliveryId = completedDelivery.deliveryId;
      await pool.query(
        `update agent_feed.consumer_deliveries
            set state = 'dead_letter', dead_lettered_at = now(), dead_letter_reason = 'consumer-test'
          where tenant_id = $1 and consumer_id = $2 and subscription_id = $3::uuid and id = $4::uuid`,
        [tenantId, consumerId, created.id, deadDeliveryId],
      );
      const deadLetters = await service.listDeadLetters({ subscriptionId: created.id });
      assert.equal(deadLetters.length, 1);
      const replay = await service.replayDeadLetter({
        subscriptionId: created.id,
        deliveryId: deadDeliveryId,
        idempotencyKey: `replay-${randomUUID()}`,
      });
      assert.equal(replay.delivery.status, "pending");

      const commandRows = await pool.query<{ count: string }>(
        `select count(*)::text as count
           from agent_feed.acknowledgement_commands
          where tenant_id = $1 and consumer_id = $2 and subscription_id = $3::uuid`,
        [tenantId, consumerId, created.id],
      );
      assert.equal(Number(commandRows.rows[0]?.count), 1);
      nowSeconds += 1;
    } finally {
      await pool.end();
    }
  },
);
