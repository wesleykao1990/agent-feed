#!/usr/bin/env node

/** Static guardrails for the durable Milestone 1 producer boundary. */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const EXTENSIONS = new Set([".js", ".mjs", ".ts", ".mts"]);

function filesUnder(pathname) {
  if (!existsSync(pathname)) return [];
  const files = [];
  function visit(entry) {
    const info = statSync(entry);
    if (info.isFile()) {
      if (EXTENSIONS.has(extname(entry))) files.push(entry);
      return;
    }
    for (const child of readdirSync(entry)) {
      if (!["dist", "node_modules"].includes(child)) visit(join(entry, child));
    }
  }
  visit(pathname);
  return files.sort();
}

function sourceImports(source) {
  return [...source.matchAll(/(?:from\s*|import\s*\(\s*)["']([^"']+)["']/gu)].map((match) => match[1]);
}

function containsSql(source) {
  return /\b(?:select\s+(?:1\b|.+\s+from)|insert\s+into|update\s+.+\s+set|delete\s+from|create\s+table|alter\s+table)\b/iu.test(source)
    || /\.\s*(?:query|execute)\s*\(/u.test(source);
}

export function checkProducerArchitecture(root = ROOT) {
  const violations = [];
  const boundaries = [
    ["producer service", "packages/producer-service/src"],
    ["producer HTTP adapter", "apps/api/src"],
    ["local-file adapter", "packages/adapters/local-file/src"],
  ];

  for (const [label, relativeRoot] of boundaries) {
    for (const pathname of filesUnder(resolve(root, relativeRoot))) {
      const source = readFileSync(pathname, "utf8");
      const display = relative(root, pathname);
      for (const specifier of sourceImports(source)) {
        if (/(^|\/)prototype(?:\/|$)/iu.test(specifier)) {
          violations.push(`${display}: ${label} imports prototype code (${specifier})`);
        }
        if (/(?:rewards?-optimizer|paypay|v[ _-]?point)/iu.test(specifier)) {
          violations.push(`${display}: ${label} imports a consumer/rewards domain (${specifier})`);
        }
        if (/^(?:pg|postgres|postgresjs|knex|kysely|drizzle-orm)(?:\/|$)/iu.test(specifier)) {
          violations.push(`${display}: ${label} imports a database driver (${specifier})`);
        }
        if (label !== "producer HTTP adapter" && specifier === "node:http") {
          violations.push(`${display}: ${label} imports HTTP transport code`);
        }
      }
      if (containsSql(source)) violations.push(`${display}: ${label} contains SQL; use the persistence port`);
    }
  }

  const apiHandler = resolve(root, "apps/api/src/index.ts");
  if (existsSync(apiHandler) && readFileSync(apiHandler, "utf8").includes("@agent-feed/persistence-postgres")) {
    violations.push("apps/api/src/index.ts: request handlers import persistence directly; use ProducerService");
  }

  const producerManifest = resolve(root, "packages/producer-service/package.json");
  if (existsSync(producerManifest)) {
    const manifest = JSON.parse(readFileSync(producerManifest, "utf8"));
    const declared = { ...manifest.dependencies, ...manifest.devDependencies, ...manifest.peerDependencies };
    if ("@agent-feed/persistence-postgres" in declared) {
      violations.push("packages/producer-service/package.json: application service depends on the concrete PostgreSQL adapter; depend on the ProducerPersistence port");
    }
  }

  for (const pathname of filesUnder(resolve(root, "packages/producer-service"))) {
    const source = readFileSync(pathname, "utf8");
    if (sourceImports(source).some((specifier) => specifier === "@agent-feed/persistence-postgres" || specifier.startsWith("@agent-feed/persistence-postgres/"))) {
      violations.push(`${relative(root, pathname)}: producer service imports the concrete PostgreSQL adapter`);
    }
  }

  for (const relativeLock of ["packages/producer-service/package-lock.json", "apps/api/package-lock.json"]) {
    const lockPath = resolve(root, relativeLock);
    if (!existsSync(lockPath)) continue;
    const lock = JSON.parse(readFileSync(lockPath, "utf8"));
    for (const [entryPath, entry] of Object.entries(lock.packages ?? {})) {
      if (entry?.name !== "@agent-feed/producer-service") continue;
      if (entry.dependencies?.["@agent-feed/persistence-postgres"] !== undefined) {
        violations.push(`${relativeLock}: ${entryPath || "root"} records a concrete PostgreSQL dependency for producer-service`);
      }
    }
  }

  return { ok: violations.length === 0, violations };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = checkProducerArchitecture();
  if (result.ok) {
    console.log("Producer architecture checks passed.");
  } else {
    console.error("Producer architecture checks failed:");
    for (const violation of result.violations) console.error(`- ${violation}`);
    process.exitCode = 1;
  }
}
