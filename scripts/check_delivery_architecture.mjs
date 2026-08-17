#!/usr/bin/env node

/**
 * Static guardrails for the Milestone 2 delivery boundary.
 *
 * This script intentionally has no dependency on the delivery implementation.
 * It passes while the M2 packages are absent, but becomes strict as soon as a
 * recognised implementation path or 0002 migration appears. That lets the
 * acceptance test land before the implementation without turning the deferred
 * M2 work into a false green.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const SOURCE_EXTENSIONS = new Set([".cjs", ".cts", ".js", ".mjs", ".mts", ".ts", ".tsx"]);

const ROOTS = Object.freeze({
  deliveryCore: [
    "packages/delivery-core",
    "apps/delivery-core",
    "delivery-core",
  ],
  protocolRuntime: [
    "packages/protocol-runtime",
    "apps/protocol-runtime",
    "protocol-runtime",
  ],
  worker: [
    "apps/delivery-worker",
    "apps/queue-worker",
    "apps/worker",
    "packages/delivery-worker",
    "delivery-worker",
    "worker",
  ],
  api: [
    "apps/delivery-api",
    "apps/api",
    "packages/delivery-consumer",
    "packages/delivery-api",
    "delivery-api",
  ],
  persistence: [
    "packages/persistence-postgres/src",
    "packages/delivery-persistence/src",
  ],
});

function sourceFiles(root, relativeRoots) {
  const files = [];

  function visit(pathname) {
    const entry = statSync(pathname);
    if (entry.isFile()) {
      if (SOURCE_EXTENSIONS.has(extname(pathname))) files.push(pathname);
      return;
    }
    if (!entry.isDirectory()) return;
    for (const child of readdirSync(pathname)) {
      if (child === ".git" || child === "node_modules" || child === "dist") continue;
      visit(join(pathname, child));
    }
  }

  for (const relativeRoot of relativeRoots) {
    const pathname = resolve(root, relativeRoot);
    if (existsSync(pathname)) visit(pathname);
  }
  return files.sort();
}

function filesUnder(root, relativeRoots, extension) {
  const result = [];
  for (const relativeRoot of relativeRoots) {
    const pathname = resolve(root, relativeRoot);
    if (!existsSync(pathname) || !statSync(pathname).isDirectory()) continue;
    for (const child of readdirSync(pathname)) {
      if (child.toLowerCase().endsWith(extension)) result.push(join(pathname, child));
    }
  }
  return result.sort();
}

function relativePath(root, pathname) {
  return relative(root, pathname) || ".";
}

function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, " "))
    .replace(/(^|[\s;])\/\/[^\n]*/g, "$1");
}

function importSpecifiers(source) {
  const withoutComments = stripComments(source);
  const specifiers = [];
  const patterns = [
    /\bfrom\s*["']([^"']+)["']/g,
    /\bimport\s*["']([^"']+)["']/g,
    /\b(?:import|require)\s*\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of withoutComments.matchAll(pattern)) specifiers.push(match[1]);
  }
  return specifiers;
}

function forbiddenBoundarySpecifier(specifier) {
  const value = specifier.toLowerCase();
  if (value.includes("supabase") || value.includes("realtime")) return "Realtime/Supabase";
  if (value.includes("reward") || value.includes("rewards-optimizer")) return "Rewards domain";
  if (/(^|[\\/])prototype([\\/]|$)/.test(value)) return "prototype";
  return null;
}

function directDatabaseSpecifier(specifier) {
  const value = specifier.toLowerCase();
  if (
    /^(?:node:)?(?:pg|postgres|postgresjs|@neondatabase|kysely|drizzle-orm|typeorm|knex)(?:\/|$)/.test(value)
  ) return true;
  return false;
}

function sqlLike(source) {
  const value = stripComments(source);
  return (
    /\bselect\s+(?:[a-z_*"`]|\$)/i.test(value)
    || /\binsert\s+into\s+/i.test(value)
    || /\bupdate\s+[a-z_"`]+\s+set\s+/i.test(value)
    || /\bdelete\s+from\s+/i.test(value)
    || /\bcreate\s+(?:table|index|schema)\b/i.test(value)
    || /\balter\s+table\b/i.test(value)
    || /\bdrop\s+(?:table|index|schema)\b/i.test(value)
    || /\.\s*(?:query|execute)\s*\(/i.test(value)
  );
}

function outboxDeliveredAtReference(source) {
  const lines = stripComments(source).split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const window = lines.slice(index, index + 12).join(" ");
    if (/outbox/i.test(window) && /delivered(?:_|)at/i.test(window)) return true;
  }
  return false;
}

function packageManifest(root, relativeRoots) {
  const manifests = [];
  for (const relativeRoot of relativeRoots) {
    const pathname = resolve(root, relativeRoot, "package.json");
    if (!existsSync(pathname)) continue;
    try {
      manifests.push({ pathname, value: JSON.parse(readFileSync(pathname, "utf8")) });
    } catch (error) {
      manifests.push({ pathname, error: `invalid package.json: ${String(error)}` });
    }
  }
  return manifests;
}

function dependencyNames(manifest) {
  const names = [];
  for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
    if (!manifest || typeof manifest[field] !== "object" || manifest[field] === null) continue;
    names.push(...Object.keys(manifest[field]));
  }
  return names;
}

function migrationFiles(root) {
  const files = filesUnder(root, ["packages/persistence-postgres/migrations", "migrations"], ".sql");
  return files.filter((pathname) => /^0002(?:[^0-9].*)?\.sql$/i.test(pathname.split(/[\\/]/).pop() ?? ""));
}

function checkDeliveryArchitecture({ root = REPOSITORY_ROOT } = {}) {
  const repositoryRoot = resolve(root);
  const violations = [];
  const skipped = [];

  const reportViolation = (pathname, message) => {
    violations.push(`${relativePath(repositoryRoot, pathname)}: ${message}`);
  };
  const reportSkip = (message) => skipped.push(message);

  const deliveryCoreFiles = sourceFiles(repositoryRoot, ROOTS.deliveryCore);
  const protocolRuntimeFiles = sourceFiles(repositoryRoot, ROOTS.protocolRuntime);
  const workerFiles = sourceFiles(repositoryRoot, ROOTS.worker);
  const apiFiles = sourceFiles(repositoryRoot, ROOTS.api);
  const persistenceFiles = sourceFiles(repositoryRoot, ROOTS.persistence);

  if (deliveryCoreFiles.length === 0) reportSkip("delivery-core: no source files found (deferred until implementation)");
  if (protocolRuntimeFiles.length === 0) reportSkip("protocol-runtime: no source files found (deferred until implementation)");
  if (workerFiles.length === 0) reportSkip("delivery worker: no source files found (deferred until implementation)");
  if (apiFiles.length === 0) reportSkip("delivery API: no source files found (deferred until implementation)");

  for (const [boundary, files] of [["delivery-core", deliveryCoreFiles], ["protocol-runtime", protocolRuntimeFiles]]) {
    for (const pathname of files) {
      const source = readFileSync(pathname, "utf8");
      for (const specifier of importSpecifiers(source)) {
        const forbidden = forbiddenBoundarySpecifier(specifier);
        if (forbidden) reportViolation(pathname, `${boundary} imports forbidden ${forbidden} module ${specifier}`);
      }
    }
  }

  for (const [boundary, roots] of [["delivery-core", ROOTS.deliveryCore], ["protocol-runtime", ROOTS.protocolRuntime]]) {
    for (const manifest of packageManifest(repositoryRoot, roots)) {
      if (manifest.error) {
        reportViolation(manifest.pathname, manifest.error);
        continue;
      }
      for (const dependency of dependencyNames(manifest.value)) {
        const forbidden = forbiddenBoundarySpecifier(dependency);
        if (forbidden) reportViolation(manifest.pathname, `${boundary} declares forbidden ${forbidden} dependency ${dependency}`);
        if (directDatabaseSpecifier(dependency)) reportViolation(manifest.pathname, `${boundary} declares database driver dependency ${dependency}`);
      }
    }
  }

  for (const pathname of deliveryCoreFiles) {
    const source = readFileSync(pathname, "utf8");
    for (const specifier of importSpecifiers(source)) {
      if (directDatabaseSpecifier(specifier)) reportViolation(pathname, `delivery-core imports database driver ${specifier}`);
      if (/^(?:node:)?(?:http|https|undici)(?:\/|$)/i.test(specifier)) {
        reportViolation(pathname, `delivery-core imports network client ${specifier}`);
      }
    }
    if (/\bfetch\s*\(/i.test(stripComments(source))) reportViolation(pathname, "delivery-core performs direct fetch/network delivery");
    if (sqlLike(source)) reportViolation(pathname, "delivery-core contains direct SQL/database access");
  }

  for (const pathname of [...workerFiles, ...apiFiles]) {
    const source = readFileSync(pathname, "utf8");
    for (const specifier of importSpecifiers(source)) {
      if (directDatabaseSpecifier(specifier)) reportViolation(pathname, `application boundary imports database driver ${specifier}; use the delivery application service`);
    }
    if (sqlLike(source)) reportViolation(pathname, "worker/API contains direct SQL/database access; use the delivery application service");
  }

  for (const [boundary, roots] of [["worker/API", ROOTS.worker], ["worker/API", ROOTS.api]]) {
    for (const manifest of packageManifest(repositoryRoot, roots)) {
      if (manifest.error) {
        reportViolation(manifest.pathname, manifest.error);
        continue;
      }
      for (const dependency of dependencyNames(manifest.value)) {
        if (directDatabaseSpecifier(dependency)) reportViolation(manifest.pathname, `${boundary} declares database driver dependency ${dependency}; use the delivery application service`);
      }
    }
  }

  for (const manifest of packageManifest(repositoryRoot, ROOTS.protocolRuntime)) {
    if (manifest.error) {
      reportViolation(manifest.pathname, manifest.error);
      continue;
    }
    if (dependencyNames(manifest.value).some((name) => /delivery[-_]core/i.test(name))) {
      reportViolation(manifest.pathname, "protocol-runtime depends on delivery-core; the protocol layer must not depend on delivery orchestration");
    }
  }

  for (const pathname of protocolRuntimeFiles) {
    const source = readFileSync(pathname, "utf8");
    for (const specifier of importSpecifiers(source)) {
      if (/delivery[-_]core/i.test(specifier)) reportViolation(pathname, `protocol-runtime imports delivery-core module ${specifier}`);
      if (/^(?:@?agent-feed\/)?(?:delivery-worker|worker|delivery-api|api)(?:\/|$)/i.test(specifier)) {
        reportViolation(pathname, `protocol-runtime imports an application boundary ${specifier}`);
      }
    }
  }

  const implementationFiles = [...deliveryCoreFiles, ...protocolRuntimeFiles, ...workerFiles, ...apiFiles, ...persistenceFiles];
  for (const pathname of implementationFiles) {
    const source = readFileSync(pathname, "utf8");
    if (outboxDeliveredAtReference(source)) {
      reportViolation(pathname, "delivery code references outbox_events.delivered_at; acknowledgement state must be per subscription");
    }
  }

  const migrations = migrationFiles(repositoryRoot);
  if (migrations.length === 0) {
    reportSkip("M2 migration: no 0002*.sql file found (deferred until durable delivery schema appears)");
  }
  for (const pathname of migrations) {
    const sql = stripComments(readFileSync(pathname, "utf8"));
    if (!/create\s+table[\s\S]{0,240}\bconsumer_subscriptions\b/i.test(sql)) {
      reportViolation(pathname, "0002 migration must define consumer_subscriptions");
    }
    if (!/\bsubscription_id\b/i.test(sql)) {
      reportViolation(pathname, "0002 migration must persist subscription_id on delivery state");
    }
    if (!/(?:delivery_attempts|acknowledg(?:ement|ements)|delivery_state|subscription_deliver)/i.test(sql)) {
      reportViolation(pathname, "0002 migration must define per-subscription attempts/acknowledgement state");
    }
    if (!/(?:lease|next_attempt_at|dead[-_ ]letter|retry)/i.test(sql)) {
      reportViolation(pathname, "0002 migration must persist lease/retry/dead-letter state");
    }
  }

  return Object.freeze({
    ok: violations.length === 0,
    violations: Object.freeze(violations),
    skipped: Object.freeze(skipped),
  });
}

export { checkDeliveryArchitecture };

function isMainModule() {
  return process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isMainModule()) {
  const result = checkDeliveryArchitecture();
  for (const message of result.skipped) console.log(`SKIP: ${message}`);
  if (result.ok) {
    console.log("Delivery architecture checks passed.");
  } else {
    console.error("Delivery architecture checks failed:");
    for (const violation of result.violations) console.error(`- ${violation}`);
    process.exitCode = 1;
  }
}
