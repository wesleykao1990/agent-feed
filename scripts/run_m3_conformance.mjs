#!/usr/bin/env node

/**
 * Run the complete Milestone 3 package/architecture/conformance gate.
 *
 * This runner deliberately does not have an allow-skip mode.  A missing
 * package, missing test/build script, or empty test directory is an
 * incomplete milestone rather than a passing local result.
 */

import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, extname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const NODE = process.execPath;
const failures = [];

const TYPESCRIPT_PACKAGES = [
  // The shared application service is part of the M3 boundary proof even
  // though its package predates the adapters. REST routing is exercised
  // in-process by the behavioral conformance test because this sandbox does
  // not permit binding a TCP listener.
  "packages/producer-service",
  "apps/api",
  "apps/mcp-server",
  "packages/sdk/typescript",
  "packages/adapters/rest",
  "packages/adapters/local-file",
  "packages/adapters/generic-webhook",
  "packages/adapters/claude-hook",
  "packages/adapters/chatgpt-manual-export",
];

function displayCommand(command, args) {
  return [command, ...args].join(" ");
}

function acceptanceSkipCount(output) {
  let count = 0;
  for (const match of output.matchAll(/^\s*ℹ\s+skipped\s+(\d+)\s*$/gimu)) count += Number(match[1]);
  count += (output.match(/^\s*#\s*SKIP\b/gimu) ?? []).length;
  for (const match of output.matchAll(/\bskipped\s*=\s*(\d+)\b/gimu)) count += Number(match[1]);
  return count;
}

function run(label, command, args, cwd = ROOT, { test = false } = {}) {
  console.log(`\n[M3] ${label}`);
  console.log(`      ${displayCommand(command, args)}`);
  const result = spawnSync(command, args, {
    cwd,
    env: process.env,
    encoding: "utf8",
    stdio: ["inherit", "pipe", "pipe"],
  });
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) {
    failures.push(`${label}: ${result.error.message}`);
    return false;
  }
  if (result.status !== 0) {
    failures.push(`${label}: exited ${String(result.status)}`);
    return false;
  }
  if (test) {
    const skipped = acceptanceSkipCount(output);
    if (skipped > 0) {
      failures.push(`${label}: ${skipped} acceptance test(s) were skipped`);
      return false;
    }
  }
  return true;
}

function packageTestFiles(packageRoot) {
  const candidates = [join(packageRoot, "test"), join(packageRoot, "tests")];
  const files = [];
  for (const directory of candidates) {
    if (!existsSync(directory) || !statSync(directory).isDirectory()) continue;
    for (const name of readdirSync(directory)) {
      const pathname = join(directory, name);
      if (!statSync(pathname).isFile()) continue;
      if (/^(?:test[_-].*|.*\.test)\.(?:c|m)?(?:t|j)s$/u.test(name)) files.push(pathname);
    }
  }
  return files.sort();
}

function runTypeScriptPackage(relativePackage) {
  const packageRoot = join(ROOT, relativePackage);
  const manifestPath = join(packageRoot, "package.json");
  if (!existsSync(manifestPath)) {
    failures.push(`${relativePackage}: package.json is missing`);
    return;
  }
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (error) {
    failures.push(`${relativePackage}: package.json is invalid (${error instanceof Error ? error.message : "parse error"})`);
    return;
  }
  if (typeof manifest.scripts?.build !== "string" || manifest.scripts.build.trim() === "") {
    failures.push(`${relativePackage}: build script is missing`);
  }
  if (typeof manifest.scripts?.test !== "string" || manifest.scripts.test.trim() === "") {
    failures.push(`${relativePackage}: test script is missing`);
  }
  const files = packageTestFiles(packageRoot);
  if (files.length === 0) {
    failures.push(`${relativePackage}: no package test files discovered`);
  }
  if (typeof manifest.scripts?.build === "string") run(`${relativePackage} clean build`, "npm", ["run", "build"], packageRoot);
  if (typeof manifest.scripts?.test === "string") run(`${relativePackage} package tests`, "npm", ["test"], packageRoot, { test: true });
}

function pythonTestFiles(packageRoot) {
  const directories = [join(packageRoot, "test"), join(packageRoot, "tests")];
  const files = [];
  for (const directory of directories) {
    if (!existsSync(directory) || !statSync(directory).isDirectory()) continue;
    for (const name of readdirSync(directory)) {
      const pathname = join(directory, name);
      if (statSync(pathname).isFile() && /^test.*\.py$/u.test(name)) files.push(pathname);
    }
  }
  return files.sort();
}

function runPythonSdk() {
  const packageRoot = join(ROOT, "packages/sdk/python");
  if (!existsSync(join(packageRoot, "agent_feed"))) failures.push("packages/sdk/python: agent_feed package is missing");
  const tests = pythonTestFiles(packageRoot);
  if (tests.length === 0) failures.push("packages/sdk/python: no Python package test files discovered");
  run("Python SDK bytecode/build check", "python3", ["-m", "compileall", "-q", "agent_feed"], packageRoot);
  if (tests.length > 0) {
    const testDirectory = existsSync(join(packageRoot, "tests")) ? "tests" : "test";
    run("Python SDK package tests", "python3", ["-m", "unittest", "discover", "-s", testDirectory, "-p", "test*.py"], packageRoot, { test: true });
  }
  const buildRoot = mkdtempSync(join(tmpdir(), "agent-feed-python-sdk-build-"));
  const sourceCopy = join(buildRoot, "source");
  const wheelhouse = join(buildRoot, "wheelhouse");
  try {
    cpSync(packageRoot, sourceCopy, {
      recursive: true,
      filter: (source) => !source.split(/[\\/]/u).some((part) => ["__pycache__", "build", "dist", "agent_feed_sdk.egg-info"].includes(part)),
    });
    const built = run("Python SDK isolated wheel build", "python3", ["-m", "pip", "wheel", "--no-deps", "--no-build-isolation", ".", "-w", wheelhouse], sourceCopy);
    if (built) {
      const wheels = readdirSync(wheelhouse).filter((name) => name.endsWith(".whl"));
      if (wheels.length !== 1) {
        failures.push(`packages/sdk/python: expected one wheel, found ${String(wheels.length)}`);
      } else {
        const environment = join(buildRoot, "consumer-venv");
        const created = run("Python SDK external consumer environment", "python3", ["-m", "venv", environment]);
        if (created) {
          const python = join(environment, "bin", "python");
          run("Python SDK external wheel install", python, ["-m", "pip", "install", "--no-deps", join(wheelhouse, wheels[0])]);
          run(
            "Python SDK external consumer import",
            python,
            ["-c", "import agent_feed; assert agent_feed.PACKAGE_VERSION == '0.1.1'; assert agent_feed.PROTOCOL_VERSION == '0.1'"],
          );
        }
      }
    }
  } finally {
    rmSync(buildRoot, { recursive: true, force: true });
  }
}

run("M3 architecture guard", NODE, ["scripts/check_m3_architecture.mjs"]);
run("M3 architecture tests", NODE, ["--test", "tests/m3/architecture.test.mjs"], ROOT, { test: true });
run("M3 behavioral conformance", NODE, ["--experimental-strip-types", "--test", "tests/m3/conformance.test.ts"], ROOT, { test: true });

for (const packageRoot of TYPESCRIPT_PACKAGES) runTypeScriptPackage(packageRoot);
runPythonSdk();

if (failures.length > 0) {
  console.error("\n[M3] CONFORMANCE INCOMPLETE/FAILED");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log("\n[M3] all architecture, behavioral, TypeScript, and Python package gates passed.");
}
