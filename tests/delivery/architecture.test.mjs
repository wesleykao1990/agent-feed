import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { checkDeliveryArchitecture } from "../../scripts/check_delivery_architecture.mjs";
import { failureSequence, twoTenantDeliveryFixture } from "./fixtures.mjs";

test("the current checkout passes architecture checks for every path present", () => {
  const result = checkDeliveryArchitecture();
  assert.equal(result.ok, true, result.violations.join("\n"));
  // M2 branches may add any recognised path before this test runs. The
  // checker is strict for present paths and reports only genuinely absent
  // components as deferred skips.
  assert.ok(Array.isArray(result.skipped));
});

test("delivery fixtures are deterministic and keep tenant/consumer scope explicit", () => {
  const first = twoTenantDeliveryFixture();
  const second = twoTenantDeliveryFixture();
  assert.deepEqual(first, second);
  assert.equal(first.tenants.length, 2);
  assert.equal(first.consumers.length, 2);
  assert.notEqual(first.events[0].tenantId, first.events[2].tenantId);
  assert.notEqual(first.subscriptions[0].consumerId, first.subscriptions[1].consumerId);
  assert.deepEqual(failureSequence("unavailable").map((item) => item.status), [503, 503, 204]);
  assert.deepEqual(failureSequence("rateLimited"), [{ kind: "response", status: 429, retryAfterSeconds: 30 }]);
});

async function writeFixture(root, pathname, contents) {
  const absolute = join(root, pathname);
  await mkdir(join(absolute, ".."), { recursive: true });
  await writeFile(absolute, contents, "utf8");
}

test("architecture checks become strict when M2 paths appear", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-feed-architecture-"));
  await writeFixture(root, "packages/delivery-core/src/index.ts", `
    import { createClient } from "@supabase/supabase-js";
    import pg from "pg";
    export async function deliver() { await fetch("https://example.invalid"); return pg; }
    const rows = "select * from agent_feed.outbox_events";
    void createClient; void rows;
  `);
  await writeFixture(root, "packages/protocol-runtime/src/index.ts", `export * from "@agent-feed/delivery-core";`);
  await writeFixture(root, "apps/worker/src/index.ts", `
    import pg from "pg";
    export const rows = pg.query("select * from agent_feed.outbox_events");
  `);
  await writeFixture(root, "apps/delivery-worker/src/ack.ts", `
    const sql = "update agent_feed.outbox_events set delivered_at = now()";
    void sql;
  `);
  await writeFixture(root, "packages/persistence-postgres/migrations/0002_delivery.sql", `
    create table agent_feed.outbox_events (id uuid primary key, delivered_at timestamptz);
  `);

  const result = checkDeliveryArchitecture({ root });
  assert.equal(result.ok, false);
  const report = result.violations.join("\n");
  assert.match(report, /Realtime\/Supabase/);
  assert.match(report, /database driver/);
  assert.match(report, /direct fetch/);
  assert.match(report, /direct SQL/);
  assert.match(report, /protocol-runtime imports delivery-core/);
  assert.match(report, /per-subscription/);
  assert.match(report, /delivered_at/);
});

test("a minimal valid package layout passes the static boundary checks", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-feed-architecture-valid-"));
  await writeFixture(root, "packages/protocol-runtime/src/index.ts", `export const protocolVersion = "0.1";`);
  await writeFixture(root, "packages/delivery-core/src/index.ts", `import { protocolVersion } from "@agent-feed/protocol-runtime"; export { protocolVersion };`);
  await writeFixture(root, "apps/delivery-worker/src/index.ts", `import { deliver } from "@agent-feed/delivery-core"; void deliver;`);
  await writeFixture(root, "apps/delivery-api/src/index.ts", `import { protocolVersion } from "@agent-feed/protocol-runtime"; void protocolVersion;`);
  await writeFixture(root, "packages/persistence-postgres/migrations/0002_delivery.sql", `
    create table agent_feed.consumer_subscriptions (
      id uuid primary key,
      subscription_id text not null,
      tenant_id text not null
    );
    create table agent_feed.delivery_attempts (
      id uuid primary key,
      subscription_id text not null,
      next_attempt_at timestamptz,
      lease_expires_at timestamptz,
      dead_lettered_at timestamptz,
      acknowledged_at timestamptz
    );
  `);

  const result = checkDeliveryArchitecture({ root });
  assert.equal(result.ok, true, result.violations.join("\n"));
});
