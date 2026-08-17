#!/usr/bin/env node

/**
 * Verify the immutable schema release candidate as an external consumer.
 *
 * This intentionally consumes only the tarball and manifest produced by
 * build_schema_artifact.mjs. It does not import the repository source package,
 * so a source-only export or an accidentally missing runtime file cannot pass
 * this gate.
 */

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const DEFAULT_ARTIFACT_DIR = "artifacts/schema";
export const MANIFEST_FILENAME = "schema-artifact-manifest.json";
export const SCHEMA_PACKAGE_NAME = "@agent-feed/schema";
export const PROTOCOL_VERSION = "0.1";
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;

const CONTRACT_NAMES = [
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

const RUNTIME_SCHEMA_NAMES = [
  "beginRun",
  "completeRun",
  "deliveryEvent",
  "evidence",
  "finding",
  "runBundle",
  "runEnvelope",
  "streamExpectation",
  "submitBatch",
];

function usage() {
  return [
    "Usage: node scripts/verify_schema_artifact.mjs [options]",
    "",
    `  --artifact-dir <path>  Artifact directory (default: ${DEFAULT_ARTIFACT_DIR})`,
    "  --help                Show this help",
  ].join("\n");
}

function parseArgs(argv) {
  const options = { artifactDir: DEFAULT_ARTIFACT_DIR };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") {
      console.log(usage());
      process.exit(0);
    }
    if (argument === "--artifact-dir") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error("--artifact-dir requires a value");
      options.artifactDir = value;
      index += 1;
      continue;
    }
    if (argument.startsWith("--artifact-dir=")) {
      options.artifactDir = argument.slice("--artifact-dir=".length);
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }
  return options;
}

function readJson(pathname, description) {
  try {
    return JSON.parse(readFileSync(pathname, "utf8"));
  } catch (error) {
    throw new Error(`Unable to read ${description} at ${pathname}: ${String(error)}`);
  }
}

function resolveArtifactDirectory(root, directory) {
  const resolved = isAbsolute(directory) ? resolve(directory) : resolve(root, directory);
  const withinRoot = relative(root, resolved);
  if (!withinRoot || withinRoot.startsWith("..") || isAbsolute(withinRoot)) {
    throw new Error(`Artifact directory must be inside the repository: ${resolved}`);
  }
  return resolved;
}

function hashFile(pathname) {
  const bytes = readFileSync(pathname);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const sha512 = createHash("sha512").update(bytes).digest("hex");
  const sha512Base64 = createHash("sha512").update(bytes).digest("base64");
  return {
    bytes: bytes.byteLength,
    sha256,
    sha512,
    sha512Base64,
    integrity: `sha512-${sha512Base64}`,
  };
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`);
  }
}

function verifyManifestAndTarball(artifactDir) {
  const manifestPath = join(artifactDir, MANIFEST_FILENAME);
  if (!existsSync(manifestPath)) {
    throw new Error(`Artifact manifest is missing: ${manifestPath}; run npm run schema:artifact first`);
  }
  const manifest = readJson(manifestPath, "schema artifact manifest");
  assertEqual(manifest.package, SCHEMA_PACKAGE_NAME, "manifest package");
  if (typeof manifest.version !== "string" || !SEMVER.test(manifest.version)) {
    throw new Error(`Manifest package version must be exact semver: ${JSON.stringify(manifest.version)}`);
  }
  if (typeof manifest.artifact !== "string" || manifest.artifact !== manifest.artifact.split(/[\\/]/).pop() || !manifest.artifact.endsWith(".tgz")) {
    throw new Error(`Manifest artifact must be a tarball basename: ${JSON.stringify(manifest.artifact)}`);
  }

  const tarballPath = join(artifactDir, manifest.artifact);
  if (!existsSync(tarballPath) || !statSync(tarballPath).isFile()) {
    throw new Error(`Artifact tarball is missing: ${tarballPath}`);
  }
  const checksums = hashFile(tarballPath);
  for (const field of ["bytes", "sha256", "sha512", "sha512Base64", "integrity"]) {
    assertEqual(manifest[field], checksums[field], `manifest ${field}`);
  }

  const listing = execFileSync("tar", ["-tzf", tarballPath], { encoding: "utf8" }).split("\n").filter(Boolean);
  const requiredEntries = [
    "package/package.json",
    "package/dist/index.js",
    "package/dist/index.d.ts",
    "package/dist/generated/protocol.d.ts",
    ...CONTRACT_NAMES.map((name) => `package/dist/contracts/${name}`),
  ];
  for (const entry of requiredEntries) {
    if (!listing.includes(entry)) throw new Error(`Artifact is missing required tarball entry: ${entry}`);
  }
  if (listing.some((entry) => entry.includes(".build-src") || entry.includes("node_modules/"))) {
    throw new Error("Artifact contains staging or dependency files");
  }

  return { manifest, tarballPath, checksums };
}

function writeExternalConsumerCheck(consumerDir, expectedVersion) {
  const checkPath = join(consumerDir, "verify-consumer.mjs");
  writeFileSync(checkPath, `
import assert from "node:assert/strict";

const packageMetadata = await import("@agent-feed/schema/package.json", { with: { type: "json" } });
const runtime = await import("@agent-feed/schema");
const directEnvelope = await import("@agent-feed/schema/contracts/run-envelope.schema.json", { with: { type: "json" } });

assert.equal(packageMetadata.default.name, "@agent-feed/schema");
assert.equal(packageMetadata.default.version, ${JSON.stringify(expectedVersion)});
assert.equal(runtime.PACKAGE_NAME, "@agent-feed/schema");
assert.equal(runtime.PACKAGE_VERSION, ${JSON.stringify(expectedVersion)});
assert.equal(runtime.PROTOCOL_VERSION, "0.1");
assert.equal(runtime.schemaManifest, runtime.schemas);
assert.equal(Object.isFrozen(runtime.schemas), true);
assert.deepEqual(Object.keys(runtime.schemas).sort(), ${JSON.stringify(RUNTIME_SCHEMA_NAMES)}.sort());
assert.deepEqual(runtime.runEnvelopeSchema, directEnvelope.default);

for (const schema of Object.values(runtime.schemas)) {
  assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
  if (schema.properties?.protocol_version) {
    assert.equal(schema.properties.protocol_version.const, "0.1");
  }
}

console.log(JSON.stringify({
  package: packageMetadata.default.name,
  version: packageMetadata.default.version,
  protocol: runtime.PROTOCOL_VERSION,
  schemas: Object.keys(runtime.schemas).sort(),
}));
`, "utf8");
  return checkPath;
}

function verifyExternalConsumer(tarballPath, expected) {
  const consumerRoot = mkdtempSync(join(tmpdir(), "agent-feed-schema-consumer-"));
  const consumerDir = join(consumerRoot, "consumer");
  const npmCacheDir = join(consumerRoot, "npm-cache");
  mkdirSync(consumerDir);
  mkdirSync(npmCacheDir);
  try {
    writeFileSync(join(consumerDir, "package.json"), JSON.stringify({
      name: "agent-feed-schema-external-consumer",
      version: "1.0.0",
      private: true,
      type: "module",
    }, null, 2) + "\n", "utf8");
    const npmEnv = {
      ...process.env,
      npm_config_cache: npmCacheDir,
      npm_config_audit: "false",
      npm_config_fund: "false",
    };
    execFileSync("npm", [
      "install",
      "--offline",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--package-lock=false",
      tarballPath,
    ], { cwd: consumerDir, env: npmEnv, stdio: "pipe" });
    const checkPath = writeExternalConsumerCheck(consumerDir, expected.version);
    const output = execFileSync(process.execPath, [checkPath], { cwd: consumerDir, encoding: "utf8" });
    const result = JSON.parse(output.trim());
    assertEqual(result.package, expected.package, "external consumer package");
    assertEqual(result.version, expected.version, "external consumer version");
    assertEqual(result.protocol, PROTOCOL_VERSION, "external consumer protocol");
    assertEqual(JSON.stringify(result.schemas), JSON.stringify(RUNTIME_SCHEMA_NAMES), "external consumer schemas");
    return result;
  } finally {
    rmSync(consumerRoot, { recursive: true, force: true });
  }
}

export function verifySchemaArtifact({
  root = REPOSITORY_ROOT,
  artifactDir = DEFAULT_ARTIFACT_DIR,
} = {}) {
  const repositoryRoot = resolve(root);
  const resolvedArtifactDir = resolveArtifactDirectory(repositoryRoot, artifactDir);
  const verified = verifyManifestAndTarball(resolvedArtifactDir);
  const consumer = verifyExternalConsumer(verified.tarballPath, verified.manifest);
  console.log(`Verified @agent-feed/schema@${verified.manifest.version} as an external consumer`);
  console.log(`SHA-256: ${verified.checksums.sha256}`);
  console.log(`SHA-512 integrity: ${verified.checksums.integrity}`);
  console.log(`Schemas: ${consumer.schemas.join(", ")}`);
  return { ...verified, consumer };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  try {
    verifySchemaArtifact(parseArgs(process.argv.slice(2)));
  } catch (error) {
    console.error(`Schema artifact verification failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
