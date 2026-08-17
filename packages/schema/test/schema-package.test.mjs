import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const contractNames = [
  "begin-run.schema.json",
  "complete-run.schema.json",
  "delivery-event.schema.json",
  "evidence.schema.json",
  "finding.schema.json",
  "run-bundle.schema.json",
  "run-envelope.schema.json",
  "stream-expectation.schema.json",
  "submit-batch.schema.json",
];

const packageJson = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8"));
const runtime = await import(path.join(packageRoot, "dist", "index.js"));

test("publishes an immutable artifact version while preserving wire protocol 0.1", () => {
  assert.equal(packageJson.name, "@agent-feed/schema");
  assert.equal(packageJson.version, "0.1.1");
  assert.equal(runtime.PACKAGE_NAME, "@agent-feed/schema");
  assert.equal(runtime.PACKAGE_VERSION, "0.1.1");
  assert.equal(runtime.PROTOCOL_VERSION, "0.1");
  assert.deepEqual(Object.keys(runtime.schemas).sort(), [
    "beginRun",
    "completeRun",
    "deliveryEvent",
    "evidence",
    "finding",
    "runBundle",
    "runEnvelope",
    "streamExpectation",
    "submitBatch",
  ]);
  for (const schema of Object.values(runtime.schemas)) {
    assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
    // Finding and evidence are embedded payload contracts, so they do not
    // repeat the envelope's protocol_version field.
    if (schema.properties?.protocol_version) {
      assert.equal(schema.properties.protocol_version.const, "0.1");
    }
  }
});

test("compiled contract bytes are identical to canonical JSON source files", async () => {
  const sourceDir = path.join(packageRoot, "contracts");
  const distDir = path.join(packageRoot, "dist", "contracts");
  assert.deepEqual((await readdir(distDir)).sort(), contractNames);
  for (const name of contractNames) {
    const source = await readFile(path.join(sourceDir, name));
    const compiled = await readFile(path.join(distDir, name));
    assert.equal(createHash("sha256").update(compiled).digest("hex"), createHash("sha256").update(source).digest("hex"), name);
  }
});

test("package content contains runtime and declaration entrypoints but no staging sources", async () => {
  await stat(path.join(packageRoot, "dist", "index.js"));
  await stat(path.join(packageRoot, "dist", "index.d.ts"));
  await stat(path.join(packageRoot, "dist", "generated", "protocol.d.ts"));
  await stat(path.join(packageRoot, "dist", "contracts", "run-envelope.schema.json"));
  await assert.rejects(stat(path.join(packageRoot, ".build-src")));
});

test("npm pack exposes a verifiable package with the exact version and contract set", async () => {
  const destination = await fsMkdirTemp();
  try {
    const raw = execFileSync("npm", ["pack", "--json", "--pack-destination", destination], {
      cwd: packageRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        npm_config_cache: path.join(destination, ".npm-cache"),
      },
    });
    const result = JSON.parse(raw)[0];
    assert.equal(result.name, "@agent-feed/schema");
    assert.equal(result.version, "0.1.1");
    assert.match(result.integrity, /^sha512-/);
    assert.ok(Number(result.unpackedSize) > 0);
    const tarball = path.join(destination, result.filename);
    const listing = execFileSync("tar", ["-tzf", tarball], { encoding: "utf8" }).split("\n").filter(Boolean);
    for (const entry of ["package/dist/index.js", "package/dist/index.d.ts", "package/dist/contracts/run-envelope.schema.json", "package/contracts/run-envelope.schema.json"]) {
      assert.ok(listing.includes(entry), entry);
    }
    assert.ok(!listing.some((entry) => entry.includes(".build-src")), "staging sources must not be published");
  } finally {
    await fsRmTemp(destination);
  }
});

async function fsMkdirTemp() {
  const { mkdtemp } = await import("node:fs/promises");
  return mkdtemp(path.join(os.tmpdir(), "agent-feed-schema-"));
}

async function fsRmTemp(directory) {
  const { rm } = await import("node:fs/promises");
  await rm(directory, { recursive: true, force: true });
}
