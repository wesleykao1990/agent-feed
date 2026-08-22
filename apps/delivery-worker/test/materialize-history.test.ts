import assert from "node:assert/strict";
import test from "node:test";

import {
	HistoricalMaterializationCliError,
	parseHistoricalMaterializationArguments,
	runHistoricalMaterialization,
} from "../src/materialize-history.ts";

const subscriptionId = "00000000-0000-4000-8000-000000000001";

test("parses repeated exact event and run IDs without a wildcard", () => {
	assert.deepEqual(
		parseHistoricalMaterializationArguments([
			"--tenant-id",
			"tenant-a",
			"--consumer-id",
			"consumer-a",
			"--subscription-id",
			subscriptionId,
			"--event-id",
			"event-a",
			"--event-id",
			"event-b",
			"--run-id",
			"run-a",
		]),
		{
			tenantId: "tenant-a",
			consumerId: "consumer-a",
			subscriptionId,
			eventIds: ["event-a", "event-b"],
			runIds: ["run-a"],
			help: false,
		},
	);
	assert.throws(
		() => parseHistoricalMaterializationArguments(["--all-history", "true"]),
		(error: unknown) =>
			error instanceof HistoricalMaterializationCliError &&
			error.code === "unknown_all_history",
	);
});

test("requires both exact sets before the repository is called", async () => {
	let calls = 0;
	await assert.rejects(
		runHistoricalMaterialization(
			{
				tenantId: "tenant-a",
				consumerId: "consumer-a",
				subscriptionId,
				eventIds: ["event-a"],
				runIds: [],
				help: false,
			},
			{ AGENT_FEED_DATABASE_URL: "postgresql://example.invalid/db" },
			{
				materialize: async () => {
					calls += 1;
					return {
						targetEvents: 1,
						insertedDeliveries: 1,
						alreadyMaterialized: 0,
					};
				},
			},
		),
		(error: unknown) =>
			error instanceof HistoricalMaterializationCliError &&
			error.code === "run_ids_required",
	);
	assert.equal(calls, 0);
});

test("passes only the bounded exact scope and returns counts", async () => {
	const result = await runHistoricalMaterialization(
		{
			tenantId: "tenant-a",
			consumerId: "consumer-a",
			subscriptionId,
			eventIds: ["event-a", "event-b"],
			runIds: ["run-a"],
			help: false,
		},
		{ AGENT_FEED_DATABASE_URL: "postgresql://example.invalid/db" },
		{
			materialize: async (input) => {
				assert.deepEqual(input, {
					tenantId: "tenant-a",
					consumerId: "consumer-a",
					subscriptionId,
					eventIds: ["event-a", "event-b"],
					runIds: ["run-a"],
				});
				return {
					targetEvents: 2,
					insertedDeliveries: 2,
					alreadyMaterialized: 0,
				};
			},
		},
	);
	assert.deepEqual(result, {
		targetEvents: 2,
		insertedDeliveries: 2,
		alreadyMaterialized: 0,
	});
});
