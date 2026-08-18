import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const execFileAsync = promisify(execFile);
const PACKAGE_ROOT = new URL("../", import.meta.url);
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";

test("packed SDK imports in an ordinary Node consumer without strip-types", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "agent-feed-sdk-pack-"));
  const consumerRoot = join(temporaryRoot, "consumer");
  const npmCache = join(temporaryRoot, "npm-cache");
  try {
    const { stdout } = await execFileAsync(npmCommand, [
      "pack",
      "--ignore-scripts",
      "--json",
      "--pack-destination",
      temporaryRoot,
    ], {
      cwd: PACKAGE_ROOT,
      env: { ...process.env, npm_config_cache: npmCache },
    });
    const packed = JSON.parse(stdout);
    assert.ok(Array.isArray(packed) && packed[0]?.filename, "npm pack did not return an archive");
    const paths = packed[0].files?.map((entry) => entry.path) ?? [];
    assert.ok(paths.some((path) => path === "dist/src/index.js"), "packed SDK is missing its ESM entrypoint");
    assert.ok(paths.some((path) => path === "dist/src/index.d.ts"), "packed SDK is missing its declaration entrypoint");
    assert.ok(
      paths.every((path) => path === "README.md" || path === "package.json" || path.startsWith("dist/")),
      `packed SDK contains source/test files: ${paths.join(", ")}`,
    );
    const archive = join(temporaryRoot, packed[0].filename);

    await execFileAsync(npmCommand, [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--prefix",
      consumerRoot,
      archive,
    ], {
      cwd: temporaryRoot,
      env: { ...process.env, npm_config_cache: npmCache },
    });

    const probe = [
      "import assert from 'node:assert/strict';",
      "import { ConsumerClient, PROTOCOL_VERSION, ProducerClient } from '@agent-feed/sdk';",
      "await import('@agent-feed/sdk/generated/protocol');",
      "assert.equal(PROTOCOL_VERSION, '0.1');",
      "assert.equal(typeof ProducerClient, 'function');",
      "assert.equal(typeof ConsumerClient, 'function');",
      "new ProducerClient({ baseUrl: 'https://feed.example.test' });",
      "new ConsumerClient({ baseUrl: 'https://feed.example.test' });",
    ].join("\n");
    await execFileAsync(process.execPath, ["--input-type=module", "-e", probe], {
      cwd: consumerRoot,
      env: { ...process.env, NODE_NO_WARNINGS: "1" },
    });
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
