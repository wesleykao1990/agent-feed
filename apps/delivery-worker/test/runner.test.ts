import assert from "node:assert/strict";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadFileDeliveryKeyResolver, summarizeDeliveryRun } from "../src/index.ts";
import {
  DeliveryCliError,
  parseDeliveryArguments,
} from "../src/main.ts";

test("key resolver loads by signing reference and never includes key material in descriptions", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-feed-delivery-"));
  const filePath = path.join(directory, "keys.json");
  await writeFile(filePath, JSON.stringify({
    "rewards-key-2026": { secret: "do-not-log-this-secret" },
  }), { mode: 0o600 });
  const resolver = await loadFileDeliveryKeyResolver(filePath);
  const ring = resolver.resolve({
    endpoint: { endpointRef: "https://rewards.example.test/events", signingKeyId: "rewards-key-2026" },
    keyId: "rewards-key-2026",
  });
  assert.deepEqual(ring.describe(), [{ keyId: "rewards-key-2026", activeFrom: 0, expiresAt: null }]);
  assert.equal(JSON.stringify(ring.describe()).includes("do-not-log-this-secret"), false);
  assert.throws(() => resolver.resolve({
    endpoint: { endpointRef: "https://rewards.example.test/events", signingKeyId: "missing" },
    keyId: "missing",
  }), (error: unknown) => error instanceof Error && error.message === "signing_key_unavailable");
});

test("key resolver rejects group-readable files and malformed key documents", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-feed-delivery-"));
  const permissionsPath = path.join(directory, "permissions.json");
  await writeFile(permissionsPath, JSON.stringify({ key: { secret: "secret" } }), { mode: 0o640 });
  if (process.platform !== "win32") {
    await assert.rejects(loadFileDeliveryKeyResolver(permissionsPath), /signing_key_file_permissions_unsafe/u);
  }
  const malformedPath = path.join(directory, "malformed.json");
  await writeFile(malformedPath, JSON.stringify({ key: { secret: "" } }), { mode: 0o600 });
  await chmod(malformedPath, 0o600);
  await assert.rejects(loadFileDeliveryKeyResolver(malformedPath), /signing_key_file_invalid/u);
});

test("CLI arguments support bounded one-shot mode and reject conflicting database sources", async () => {
  const parsed = parseDeliveryArguments([
    "--once",
    "--database-url-file", "/private/url",
    "--tenant-id", "rewards-local",
    "--consumer-id", "rewards-optimizer",
    "--signing-keys-file", "/private/keys.json",
    "--batch-size", "64",
  ]);
  assert.equal(parsed.once, true);
  assert.equal(parsed.batchSize, 64);
  assert.throws(
    () => parseDeliveryArguments(["--database-url", "postgresql://user:password@localhost/db", "--database-url-file", "/private/url"]),
    (error: unknown) => error instanceof DeliveryCliError && error.code === "database_url_source_conflict",
  );
});

test("run summary contains counts only, not event payloads", () => {
  const summary = summarizeDeliveryRun({
    claimed: 4,
    items: [
      { deliveryId: "d1", eventId: "e1", attempt: 1, outcome: "acknowledged" },
      { deliveryId: "d2", eventId: "e2", attempt: 1, outcome: "retry_scheduled", error: { code: "network_error", message: "safe", retryable: true, status: null } },
      { deliveryId: "d3", eventId: "e3", attempt: 1, outcome: "dead_lettered", error: { code: "signing_error", message: "safe", retryable: false, status: null } },
      { deliveryId: "d4", eventId: "e4", attempt: 1, outcome: "stale_lease" },
    ],
  });
  assert.deepEqual(summary, {
    claimed: 4,
    acknowledged: 1,
    retryScheduled: 1,
    deadLettered: 1,
    staleLease: 1,
    failed: 0,
  });
  assert.equal(JSON.stringify(summary).includes("e1"), false);
});
