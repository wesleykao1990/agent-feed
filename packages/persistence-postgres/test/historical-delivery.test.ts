import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import {
	PostgresAgentFeedPersistence,
	PostgresDeliveryRepository,
	createAgentFeedPool,
	migrateAgentFeed,
} from "../src/index.ts";
import type {
	BeginRunRequest,
	CompleteRunRequest,
	EvidencePayload,
	FindingPayload,
	SubmitBatchRequest,
} from "../src/index.ts";

const databaseUrl = process.env.AGENT_FEED_DATABASE_URL;

function begin(
	tenantId: string,
	streamId: string,
	runId: string,
): BeginRunRequest {
	return {
		protocol_version: "0.1",
		tenant_id: tenantId,
		idempotency_key: `begin-${randomUUID()}`,
		stream_id: streamId,
		producer: {
			producer_id: `historical-delivery-${tenantId}`,
			type: "automation",
			name: "historical-delivery-test",
			version: "1",
		},
		task: {
			task_type: "historical-delivery-regression",
			definition_id: null,
			definition_version: null,
		},
		expected_scope: { source_ids: [], subjects: [], queries: [], metadata: {} },
		started_at: "2026-08-22T00:00:00.000Z",
		parent_run_id: null,
		metadata: {},
		run_id: runId,
	};
}

function evidence(evidenceId: string): EvidencePayload {
	return {
		evidence_id: evidenceId,
		kind: "web",
		source: { uri: "https://example.invalid/historical", title: "synthetic" },
		captured_at: "2026-08-22T00:00:01.000Z",
		published_at: null,
		locator: null,
		excerpt: "synthetic historical delivery evidence",
		content_hash: null,
		artifact: {},
		handling: {
			contains_personal_data: false,
			contains_secrets: false,
			redistribution_restricted: false,
		},
		metadata: {},
	};
}

test(
	"historical materialization is exact, selector-bound, cross-run checked, and idempotent",
	{ skip: databaseUrl ? false : "AGENT_FEED_DATABASE_URL is not set" },
	async () => {
		const pool = createAgentFeedPool(databaseUrl);
		try {
			await migrateAgentFeed(pool);
			const persistence = new PostgresAgentFeedPersistence(pool);
			const repository = new PostgresDeliveryRepository(pool);
			const tenantId = `historical-${randomUUID()}`;
			const consumerId = `consumer-${randomUUID()}`;
			const streamId = `historical.stream.${randomUUID()}`;
			const runId = randomUUID();
			const findingId = `finding-${randomUUID()}`;
			const evidenceId = `evidence-${randomUUID()}`;

			await persistence.beginRun(begin(tenantId, streamId, runId));
			const batch: SubmitBatchRequest = {
				protocol_version: "0.1",
				tenant_id: tenantId,
				run_id: runId,
				batch_id: `batch-${randomUUID()}`,
				idempotency_key: `batch-${randomUUID()}`,
				sequence_number: 1,
				submitted_at: "2026-08-22T00:00:01.000Z",
				findings: [
					{
						finding_id: findingId,
						finding_type: "delivery.synthetic",
						title: "Historical synthetic",
						summary: "Historical synthetic finding",
						subjects: [],
						evidence_refs: [evidenceId],
						security_flags: [],
						routing_tags: ["historical"],
					} as FindingPayload,
				],
				evidence: [evidence(evidenceId)],
				metadata: {},
			};
			await persistence.submitBatch(batch);
			const terminal: CompleteRunRequest = {
				protocol_version: "0.1",
				tenant_id: tenantId,
				run_id: runId,
				idempotency_key: `complete-${randomUUID()}`,
				status: "completed",
				completed_at: "2026-08-22T00:00:02.000Z",
				actual_scope: {
					source_ids: [],
					subjects: [],
					queries: [],
					metadata: {},
				},
				stats: {
					sources_attempted: 1,
					sources_succeeded: 1,
					findings_submitted: 1,
					evidence_submitted: 1,
					batches_submitted: 1,
				},
				errors: [],
				metadata: {},
			};
			await persistence.completeRun(terminal);

			const events = await pool.query<{ event_id: string }>(
				`select event_id
           from agent_feed.outbox_events
          where tenant_id = $1 and wire_run_id = $2
          order by delivery_position, event_id`,
				[tenantId, runId],
			);
			const eventIds = events.rows.map((row) => row.event_id);
			assert.equal(eventIds.length, 3);

			const subscription = await repository.registerSubscription({
				tenantId,
				consumerId,
				streamIds: [streamId],
				findingTypes: ["delivery.synthetic"],
				routingTags: { mode: "all", values: ["historical"] },
				eventTypes: ["run.started", "finding.submitted", "run.completed"],
				includeRunEvents: true,
				deliveryMode: "pull",
			});
			const countDeliveries = async (): Promise<number> => {
				const result = await pool.query<{ count: string }>(
					`select count(*)::text as count
             from agent_feed.consumer_deliveries
            where tenant_id = $1 and consumer_id = $2 and subscription_id = $3::uuid`,
					[tenantId, consumerId, subscription.subscriptionId],
				);
				return Number(result.rows[0]?.count);
			};
			assert.equal(
				await countDeliveries(),
				0,
				"future subscription cannot see historical events automatically",
			);

			assert.deepEqual(
				await repository.materializeHistoricalDeliveries({
					tenantId,
					consumerId,
					subscriptionId: subscription.subscriptionId,
					eventIds: [...eventIds].reverse(),
					runIds: [runId],
				}),
				{ targetEvents: 3, insertedDeliveries: 3, alreadyMaterialized: 0 },
			);
			assert.equal(await countDeliveries(), 3);
			assert.deepEqual(
				await repository.materializeHistoricalDeliveries({
					tenantId,
					consumerId,
					subscriptionId: subscription.subscriptionId,
					eventIds,
					runIds: [runId],
				}),
				{ targetEvents: 3, insertedDeliveries: 0, alreadyMaterialized: 3 },
			);

			for (const hostile of [
				{
					eventIds: [...eventIds, "event-that-does-not-exist"],
					runIds: [runId],
				},
				{ eventIds, runIds: [randomUUID()] },
				{ eventIds: [eventIds[0]!, eventIds[0]!], runIds: [runId] },
			]) {
				await assert.rejects(
					repository.materializeHistoricalDeliveries({
						tenantId,
						consumerId,
						subscriptionId: subscription.subscriptionId,
						...hostile,
					}),
					/historical_/u,
				);
				assert.equal(
					await countDeliveries(),
					3,
					"failed exact-set preflight changes no delivery rows",
				);
			}

			await assert.rejects(
				repository.materializeHistoricalDeliveries({
					tenantId,
					consumerId: `${consumerId}-other`,
					subscriptionId: subscription.subscriptionId,
					eventIds,
					runIds: [runId],
				}),
				/historical_subscription_unavailable/u,
			);
			assert.equal(await countDeliveries(), 3);
		} finally {
			await pool.end();
		}
	},
);
