import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { checkM4Architecture } from "../../scripts/check_m4_architecture.mjs";

async function put(root, pathname, contents) {
  const target = join(root, pathname);
  await mkdir(join(target, ".."), { recursive: true });
  await writeFile(target, contents, "utf8");
}

function packageJson(dependencies = {}) {
  return JSON.stringify({
    name: "fixture-rewards-reference-consumer",
    version: "0.1.0",
    type: "module",
    scripts: { build: "node --check src/index.js", test: "node --test" },
    exports: { ".": "./src/index.js" },
    dependencies,
  });
}

const SAFE_SOURCE = `
  export const protocol_version = "0.1";
  export const supported_event_type = "finding.submitted";
  export const allowed_stream_ids = ["stream.example"];
  export function createReferenceConsumer() {
    const transport_receipts = new Set();
    const semantic_fingerprints = new Map();
    return {
      consume(event, scope) {
        const transport_receipt = { event_id: event.event_id, tenant_id: scope.tenant_id, consumer_id: scope.consumer_id, stream_id: event.stream_id };
        const semantic_fingerprint = "v1:" + event.payload.finding.producer_dedupe_key;
        void transport_receipts; void semantic_fingerprints;
        return { transport_receipt, semantic_fingerprint, source_observation: {
          trust: "untrusted", tenant_id: scope.tenant_id, consumer_id: scope.consumer_id, stream_id: event.stream_id,
          submitted_evidence: event.payload.submitted_evidence,
        } };
      },
    };
  }
`;

test("the repository M4 architecture gate is fail-closed and has no acceptance skip result", () => {
  const result = checkM4Architecture();
  assert.equal(Object.hasOwn(result, "skipped"), false);
  assert.equal(Array.isArray(result.missing), true);
  assert.equal(result.ok, true, result.violations.join("\n"));
});

test("the architecture gate accepts a public, storage-free reference package", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-feed-m4-architecture-"));
  await put(root, "examples/rewards-optimizer/package.json", packageJson({ "@agent-feed/schema": "0.1.1" }));
  await put(root, "examples/rewards-optimizer/src/index.js", SAFE_SOURCE);

  const result = checkM4Architecture({ root });
  assert.equal(result.ok, true, result.violations.join("\n"));
  assert.deepEqual(result.missing, []);
  assert.ok(result.checked.includes("examples/rewards-optimizer/src/index.js"));
});

test("the architecture gate checks clean source before a declared dist export is built", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-feed-m4-architecture-clean-"));
  const manifest = JSON.parse(packageJson({ "@agent-feed/sdk": "0.1.1" }));
  manifest.exports = { ".": { import: "./dist/index.js" } };
  await put(root, "examples/rewards-optimizer/package.json", JSON.stringify(manifest));
  await put(root, "examples/rewards-optimizer/src/index.js", SAFE_SOURCE);

  const result = checkM4Architecture({ root });
  assert.equal(result.ok, true, result.violations.join("\n"));
  assert.ok(result.checked.includes("examples/rewards-optimizer/src/index.js"));
});

test("the architecture gate rejects private server/database/SQL/domain-output leaks", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-feed-m4-architecture-leak-"));
  await put(root, "examples/rewards-optimizer/package.json", packageJson({
    pg: "8.0.0",
    "@agent-feed/api": "file:../../apps/api",
    "@agent-feed/schema/src": "file:../../packages/schema/src",
  }));
  await put(root, "examples/rewards-optimizer/src/index.js", `
    import pg from "pg";
    import { app } from "@agent-feed/api";
    import { types } from "@agent-feed/schema/src/index.ts";
    const rows = "select * from agent_feed.runs";
    console.error(error);
    export const RewardRule = {};
    export function createReferenceConsumer() { return { consume: () => ({}) }; }
  `);

  const result = checkM4Architecture({ root });
  assert.equal(result.ok, false);
  const report = result.violations.join("\n");
  assert.match(report, /database\/SQL module import|database dependency pg/iu);
  assert.match(report, /server\/application import|server\/application dependency/iu);
  assert.match(report, /private \/src/iu);
  assert.match(report, /SQL or direct database query/iu);
  assert.match(report, /raw payload\/evidence\/error/iu);
  assert.match(report, /reward-rule.*promotion output/iu);
});

test("the architecture gate rejects a README-only or manifest-only consumer", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-feed-m4-architecture-empty-"));
  await put(root, "examples/rewards-optimizer/package.json", packageJson());
  await put(root, "examples/rewards-optimizer/README.md", "A future reference consumer.");

  const result = checkM4Architecture({ root });
  assert.equal(result.ok, false);
  assert.ok(result.missing.some((message) => /entrypoint|implementation source/iu.test(message)));
  assert.equal(Object.hasOwn(result, "skipped"), false);
});

test("the architecture gate rejects a package without a manifest", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-feed-m4-architecture-no-manifest-"));
  await put(root, "examples/rewards-optimizer/src/index.js", SAFE_SOURCE);

  const result = checkM4Architecture({ root });
  assert.equal(result.ok, false);
  assert.ok(result.missing.some((message) => /package\.json.*missing/iu.test(message)));
});
