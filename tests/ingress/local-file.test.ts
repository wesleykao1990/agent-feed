import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { LocalFileRunBundleAdapter } from "../../packages/adapters/local-file/src/index.ts";
import {
  ProducerService,
  StaticProducerAuthenticator,
} from "../../packages/producer-service/src/index.ts";
import {
  PostgresAgentFeedPersistence,
  createAgentFeedPool,
  migrateAgentFeed,
} from "../../packages/persistence-postgres/src/index.ts";

const databaseUrl = process.env.AGENT_FEED_DATABASE_URL;

test("durable local-file ingress preserves a non-UUID wire ID and exact retry receipts", {
  skip: databaseUrl ? false : "AGENT_FEED_DATABASE_URL is required for the durable local-file gate",
}, async () => {
  const pool = createAgentFeedPool(databaseUrl);
  try {
    await migrateAgentFeed(pool);
    const persistence = new PostgresAgentFeedPersistence(pool);
    const suffix = randomUUID();
    const wireRunId = `run_local_file_${suffix}`;
    const fixture = JSON.parse(
      await readFile(new URL("../../examples/run-bundle.zero-findings.example.json", import.meta.url), "utf8"),
    ) as Record<string, unknown>;
    const begin = fixture.begin as Record<string, unknown>;
    const complete = fixture.complete as Record<string, unknown>;
    fixture.run_id = wireRunId;
    begin.idempotency_key = `begin-${suffix}`;
    complete.run_id = wireRunId;
    complete.idempotency_key = `complete-${suffix}`;

    const credentials = [{
      tenant_id: `tenant-local-${suffix}`,
      producer_id: "openai-monitor-jp",
      secret: `secret-${suffix}`,
      allowed_stream_ids: ["generic.zero-findings"],
    }];
    const service = new ProducerService({
      persistence,
      authenticator: new StaticProducerAuthenticator(credentials),
    });
    const principal = service.authenticate({ authorization: `Bearer ${credentials[0]!.secret}` });
    const adapter = new LocalFileRunBundleAdapter({ service, principal });
    const raw = JSON.stringify(fixture);

    const first = await adapter.importJson(raw);
    const retry = await adapter.importJson(raw);
    assert.deepEqual(retry, first);
    assert.equal((first.complete as { run_id: string }).run_id, wireRunId);

    const stored = await persistence.getRunForTenant(credentials[0]!.tenant_id, wireRunId);
    assert.equal(stored?.run_id, wireRunId);
    assert.equal(stored?.status, "completed");
    assert.equal(stored?.findings.length, 0);

    const rows = await pool.query<{ runs: string; events: string }>(
      `select
         (select count(*)::text from agent_feed.runs where tenant_id = $1 and wire_run_id = $2) as runs,
         (select count(*)::text from agent_feed.outbox_events where tenant_id = $1 and wire_run_id = $2) as events`,
      [credentials[0]!.tenant_id, wireRunId],
    );
    assert.equal(rows.rows[0]?.runs, "1");
    assert.equal(rows.rows[0]?.events, "2");
  } finally {
    await pool.end();
  }
});
