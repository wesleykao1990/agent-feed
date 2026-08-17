#!/usr/bin/env node

/**
 * Build the publishable Agent Feed schema artifact.
 *
 * This is intentionally independent of the repository's other package
 * projects. The schema package is installed from its own lockfile, built,
 * tested, and packed before the checksums are calculated. No npm publish is
 * performed here: the tag-gated workflow owns release-asset upload.
 */

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

export const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const DEFAULT_PACKAGE_DIR = "packages/schema";
export const DEFAULT_OUTPUT_DIR = "artifacts/schema";
export const MANIFEST_FILENAME = "schema-artifact-manifest.json";
export const SCHEMA_PACKAGE_NAME = "@agent-feed/schema";
export const SCHEMA_TAG_PREFIX = "schema-v";

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function usage() {
  return [
    "Usage: node scripts/build_schema_artifact.mjs [options]",
    "",
    "Options:",
    `  --package-dir <path>  Schema package directory (default: ${DEFAULT_PACKAGE_DIR})`,
    `  --output-dir <path>   Artifact directory (default: ${DEFAULT_OUTPUT_DIR})`,
    "  --tag <schema-vX.Y.Z> Validate that the release tag matches package.version",
    "  --help                Show this help",
  ].join("\n");
}

function parseArgs(argv) {
  const options = {
    packageDir: DEFAULT_PACKAGE_DIR,
    outputDir: DEFAULT_OUTPUT_DIR,
    tag: process.env.GITHUB_REF_NAME ?? null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") {
      console.log(usage());
      process.exit(0);
    }
    if (argument === "--package-dir" || argument === "--output-dir" || argument === "--tag") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${argument} requires a value`);
      index += 1;
      if (argument === "--package-dir") options.packageDir = value;
      if (argument === "--output-dir") options.outputDir = value;
      if (argument === "--tag") options.tag = value;
      continue;
    }
    if (argument.startsWith("--package-dir=")) {
      options.packageDir = argument.slice("--package-dir=".length);
      continue;
    }
    if (argument.startsWith("--output-dir=")) {
      options.outputDir = argument.slice("--output-dir=".length);
      continue;
    }
    if (argument.startsWith("--tag=")) {
      options.tag = argument.slice("--tag=".length);
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }
  return options;
}

function readJson(pathname, description) {
  let value;
  try {
    value = JSON.parse(readFileSync(pathname, "utf8"));
  } catch (error) {
    throw new Error(`Unable to read ${description} at ${pathname}: ${String(error)}`);
  }
  return value;
}

function assertSemver(version, description) {
  if (typeof version !== "string" || !SEMVER.test(version)) {
    throw new Error(`${description} must be an exact semantic version, received ${JSON.stringify(version)}`);
  }
}

function assertTagMatchesVersion(tag, version) {
  if (tag === null || tag === undefined || tag === "") return;
  if (!tag.startsWith(SCHEMA_TAG_PREFIX)) {
    throw new Error(`Release tag must start with ${SCHEMA_TAG_PREFIX}, received ${tag}`);
  }
  const tagVersion = tag.slice(SCHEMA_TAG_PREFIX.length);
  assertSemver(tagVersion, "release tag version");
  if (tagVersion !== version) {
    throw new Error(`Release tag ${tag} does not match schema package version ${version}`);
  }
}

function packagePath(root, pathname) {
  return isAbsolute(pathname) ? resolve(pathname) : resolve(root, pathname);
}

function assertSafeOutputDirectory(root, outputDir) {
  const relativeOutput = relative(root, outputDir);
  if (!relativeOutput || relativeOutput.startsWith("..") || isAbsolute(relativeOutput)) {
    throw new Error(`Artifact output directory must be inside the repository: ${outputDir}`);
  }
  if (outputDir === root) throw new Error("Refusing to use the repository root as artifact output");
}

function prepareOutputDirectory(root, outputDir) {
  assertSafeOutputDirectory(root, outputDir);
  mkdirSync(outputDir, { recursive: true });

  // Keep reruns safe and deterministic without recursively deleting arbitrary
  // user files. Only outputs produced by this script may be removed.
  for (const entry of readdirSync(outputDir)) {
    if (entry.endsWith(".tgz") || entry === MANIFEST_FILENAME) {
      rmSync(join(outputDir, entry), { force: true });
      continue;
    }
    throw new Error(`Artifact output directory contains unexpected file: ${join(outputDir, entry)}`);
  }
}

function runNpm(packageDir, args, npmCacheDir) {
  try {
    return execFileSync("npm", args, {
      cwd: packageDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        npm_config_audit: "false",
        npm_config_fund: "false",
        // npm pack may write cache metadata even when it does not install a
        // dependency. A per-run cache keeps the artifact build isolated from
        // a developer's global cache and lets nested package tests inherit the
        // same clean cache.
        npm_config_cache: npmCacheDir,
      },
    });
  } catch (error) {
    const stdout = error.stdout ? `\nstdout:\n${error.stdout}` : "";
    const stderr = error.stderr ? `\nstderr:\n${error.stderr}` : "";
    throw new Error(`npm ${args.join(" ")} failed in ${packageDir}: ${String(error)}${stdout}${stderr}`);
  }
}

function hashFile(pathname) {
  const bytes = readFileSync(pathname);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const sha512Hex = createHash("sha512").update(bytes).digest("hex");
  const sha512Base64 = createHash("sha512").update(bytes).digest("base64");
  return {
    bytes: bytes.byteLength,
    sha256,
    sha512: sha512Hex,
    sha512Base64,
    integrity: `sha512-${sha512Base64}`,
  };
}

function packageLockMatchesManifest(lock, manifest) {
  const rootPackage = lock?.packages?.[""];
  return rootPackage?.name === manifest.name && rootPackage?.version === manifest.version;
}

export function buildSchemaArtifact({
  root = REPOSITORY_ROOT,
  packageDir = DEFAULT_PACKAGE_DIR,
  outputDir = DEFAULT_OUTPUT_DIR,
  tag = process.env.GITHUB_REF_NAME ?? null,
} = {}) {
  const repositoryRoot = resolve(root);
  const schemaDir = packagePath(repositoryRoot, packageDir);
  const artifactDir = packagePath(repositoryRoot, outputDir);
  const manifestPath = join(schemaDir, "package.json");
  const lockPath = join(schemaDir, "package-lock.json");

  if (!existsSync(manifestPath)) {
    throw new Error(`Schema package manifest is missing: ${manifestPath}`);
  }
  if (!existsSync(lockPath)) {
    throw new Error(`Schema package lockfile is missing: ${lockPath}; npm ci requires a committed lockfile`);
  }
  const manifest = readJson(manifestPath, "schema package manifest");
  if (manifest.name !== SCHEMA_PACKAGE_NAME) {
    throw new Error(`Schema package must be named ${SCHEMA_PACKAGE_NAME}, received ${JSON.stringify(manifest.name)}`);
  }
  if (manifest.private === true) {
    throw new Error("Schema package must not be private when producing a publishable artifact");
  }
  assertSemver(manifest.version, "schema package version");
  assertTagMatchesVersion(tag, manifest.version);
  for (const scriptName of ["build", "test"]) {
    if (typeof manifest.scripts?.[scriptName] !== "string" || manifest.scripts[scriptName].trim() === "") {
      throw new Error(`Schema package must define npm script ${scriptName}`);
    }
  }
  const lock = readJson(lockPath, "schema package lockfile");
  if (!packageLockMatchesManifest(lock, manifest)) {
    throw new Error("Schema package package-lock.json root name/version does not match package.json");
  }

  prepareOutputDirectory(repositoryRoot, artifactDir);

  const npmCacheDir = mkdtempSync(join(tmpdir(), "agent-feed-schema-npm-cache-"));
  try {
    console.log(`Installing ${manifest.name}@${manifest.version} with npm ci`);
    runNpm(schemaDir, ["ci", "--ignore-scripts", "--no-audit", "--no-fund"], npmCacheDir);
    console.log("Building schema package");
    runNpm(schemaDir, ["run", "build"], npmCacheDir);
    console.log("Testing schema package");
    runNpm(schemaDir, ["test"], npmCacheDir);

    console.log("Packing schema package");
    const packOutput = runNpm(schemaDir, [
      "pack",
      "--json",
      "--ignore-scripts",
      "--pack-destination",
      artifactDir,
    ], npmCacheDir);
    let packed;
    try {
      packed = JSON.parse(packOutput.trim());
    } catch (error) {
      throw new Error(`npm pack did not return JSON metadata: ${String(error)}\n${packOutput}`);
    }
    if (!Array.isArray(packed) || packed.length !== 1 || typeof packed[0]?.filename !== "string") {
      throw new Error(`Unexpected npm pack metadata: ${packOutput}`);
    }
    if (packed[0].name !== manifest.name || packed[0].version !== manifest.version) {
      throw new Error(
        `npm pack metadata does not match package.json: ${JSON.stringify({
          packedName: packed[0].name,
          packedVersion: packed[0].version,
          manifestName: manifest.name,
          manifestVersion: manifest.version,
        })}`,
      );
    }

    const filename = packed[0].filename.split(/[\\/]/).pop();
    if (!filename || !filename.endsWith(".tgz")) throw new Error(`Invalid npm pack filename: ${packed[0].filename}`);
    const tarballPath = join(artifactDir, filename);
    if (!existsSync(tarballPath) || !statSync(tarballPath).isFile()) {
      throw new Error(`npm pack did not create the expected tarball: ${tarballPath}`);
    }
    const checksums = hashFile(tarballPath);
    if (packed[0].integrity && packed[0].integrity !== checksums.integrity) {
      throw new Error(`npm pack integrity does not match the tarball bytes: ${packed[0].integrity} != ${checksums.integrity}`);
    }
    const artifactManifest = {
      artifact: filename,
      package: SCHEMA_PACKAGE_NAME,
      version: manifest.version,
      integrity: checksums.integrity,
      sha512: checksums.sha512,
      sha512Base64: checksums.sha512Base64,
      sha256: checksums.sha256,
      bytes: checksums.bytes,
      ...(tag ? { tag } : {}),
    };
    const artifactManifestPath = join(artifactDir, MANIFEST_FILENAME);
    writeFileSync(artifactManifestPath, `${JSON.stringify(artifactManifest, null, 2)}\n`, "utf8");

    console.log(`Schema artifact: ${filename}`);
    console.log(`Version: ${manifest.version}`);
    console.log(`SHA-512 integrity: ${checksums.integrity}`);
    console.log(`SHA-256: ${checksums.sha256}`);
    console.log(`Manifest: ${artifactManifestPath}`);

    return {
      packageName: SCHEMA_PACKAGE_NAME,
      version: manifest.version,
      filename,
      tarballPath,
      manifestPath: artifactManifestPath,
      ...checksums,
      tag: tag ?? null,
    };
  } finally {
    rmSync(npmCacheDir, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  try {
    buildSchemaArtifact(parseArgs(process.argv.slice(2)));
  } catch (error) {
    console.error(`Schema artifact build failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
