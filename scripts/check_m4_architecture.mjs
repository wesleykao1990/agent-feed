#!/usr/bin/env node

/**
 * Static boundary checks for the Milestone 4 reference consumer.
 *
 * This checker deliberately treats a missing example package as a failure.
 * M4 is a reference integration, not a documentation-only milestone: the
 * package must be importable through its public entry point and its own
 * production source must remain domain-neutral and storage-free.
 */

import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import {
  dirname,
  extname,
  join,
  relative,
  resolve,
} from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGE_PATH = "examples/rewards-optimizer";
const SOURCE_EXTENSIONS = new Set([".js", ".mjs", ".cjs", ".ts", ".mts", ".cts", ".py"]);

// These patterns are applied to actual module specifiers and dependency keys,
// rather than the whole source text.  Domain-shaped words in comments and
// type-field names must not manufacture a false private-dependency finding.
const DATABASE_MODULE = /^(?:@agent-feed\/(?:persistence-postgres|postgres|database)(?:\/|$)|pg|postgres|postgresjs|knex|kysely|drizzle-orm|sequelize|psycopg|asyncpg|sqlalchemy)(?:\/|$)/iu;
const SERVER_MODULE = /^(?:@agent-feed\/(?:api|delivery-api|producer-service|persistence-postgres)(?:\/|$)|(?:\.?\.?\/)+(?:apps|packages)\/(?:api|mcp-server|producer-service|persistence-postgres)(?:\/|$))/iu;
const SOURCE_SUBPATH_MODULE = /(?:@agent-feed\/[^"'\s]+\/src(?:\/|$)|(?:\.?\.?\/)+(?:apps|packages)\/[^"'\s]+\/src(?:\/|$))/iu;
const SQL = /\b(?:select\s+.+\s+from|insert\s+into|update\s+.+\s+set|delete\s+from|create\s+table|alter\s+table|drop\s+table)\b|\.\s*(?:query|execute)\s*\(/iu;
const RAW_LOG = /(?:console\.(?:debug|info|log|warn|error)|\bprint)\s*\([^\n]*(?:\berror\b|\bexception\b|\bauthorization\b|\bbearer\b|\bsecret\b|\btoken\b|\bpayload\b|\bevidence\b|\bexcerpt\b)[^\n]*\)/iu;
const FORBIDDEN_DOMAIN_OUTPUT = /\b(?:RewardRule(?:Version)?|Canonical(?:Evidence|SourceSnapshot)|promote(?:d|s|ion)?(?:RewardRule|Rule)|publish(?:ed|es)?RewardRule|reward_rule(?:_version)?|canonical_evidence(?:_ids)?|canonical_source_snapshot|promotion_output|promotion_decision)\b/iu;

function filesUnder(pathname) {
  if (!existsSync(pathname)) return [];
  const files = [];
  function visit(entry) {
    const info = statSync(entry);
    if (info.isFile()) {
      if (SOURCE_EXTENSIONS.has(extname(entry).toLowerCase())) files.push(entry);
      return;
    }
    for (const child of readdirSync(entry)) {
      if (["node_modules", "dist", "build", "coverage", ".git"].includes(child)) continue;
      visit(join(entry, child));
    }
  }
  visit(pathname);
  return files.sort();
}

function stripComments(source) {
  let output = "";
  let quote = null;
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1];
    if (quote !== null) {
      output += character;
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === quote) {
        quote = null;
      }
      continue;
    }
    if (character === "\"" || character === "'" || character === "`") {
      quote = character;
      output += character;
    } else if (character === "/" && next === "/") {
      index += 1;
      while (index + 1 < source.length && source[index + 1] !== "\n") index += 1;
      output += "\n";
    } else if (character === "/" && next === "*") {
      index += 2;
      while (index < source.length && !(source[index] === "*" && source[index + 1] === "/")) {
        if (source[index] === "\n") output += "\n";
        index += 1;
      }
      if (index < source.length) index += 1;
    } else {
      output += character;
    }
  }
  return output;
}

function sourceImports(source) {
  const code = stripComments(source);
  const imports = [];
  const patterns = [
    /^\s*import\s+(?:type\s+)?(?:[\s\S]*?\s+from\s*)?["']([^"']+)["']/gmu,
    /\bimport\s+(?:type\s+)?(?:[^;\n]*?\s+from\s*)?["']([^"']+)["']/gu,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/gu,
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/gu,
    /\bexport\s+(?:type\s+)?[^;\n]*?\s+from\s*["']([^"']+)["']/gu,
    /^\s*from\s+["']?([A-Za-z_][A-Za-z0-9_.@/-]*)["']?\s+import\b/gmu,
  ];
  for (const pattern of patterns) {
    for (const match of code.matchAll(pattern)) imports.push(match[1]);
  }
  return [...new Set(imports.filter((specifier) => typeof specifier === "string"))];
}

function readManifest(pathname, violations) {
  try {
    return JSON.parse(readFileSync(pathname, "utf8"));
  } catch (error) {
    violations.push(`${relative(ROOT, pathname)}: package manifest is not valid JSON (${error instanceof Error ? error.message : "parse error"})`);
    return null;
  }
}

function dependencyNames(manifest) {
  return Object.entries({
    ...manifest?.dependencies,
    ...manifest?.devDependencies,
    ...manifest?.peerDependencies,
    ...manifest?.optionalDependencies,
  }).map(([name]) => name);
}

function packageExportTarget(manifest) {
  const rootExport = manifest?.exports?.["."] ?? manifest?.exports;
  if (typeof rootExport === "string") return rootExport;
  if (rootExport && typeof rootExport === "object") {
    for (const key of ["import", "require", "default", "node"]) {
      if (typeof rootExport[key] === "string") return rootExport[key];
    }
  }
  for (const key of ["module", "main"]) {
    if (typeof manifest?.[key] === "string") return manifest[key];
  }
  return null;
}

function resolvePublicEntrypoint(packageRoot, manifest) {
  const target = packageExportTarget(manifest);
  // A clean checkout has no ignored dist/ directory until the build runs. The
  // architecture gate still checks the declared public target, then falls back
  // to production source for static analysis. M4 conformance separately builds
  // and imports the declared public export.
  const candidates = [
    ...(target ? [target] : []),
    "src/index.ts",
    "src/index.mts",
    "src/index.js",
    "src/index.mjs",
    "index.ts",
    "index.js",
    "index.mjs",
  ];
  for (const candidate of candidates) {
    if (typeof candidate !== "string" || candidate.startsWith("#")) continue;
    const normalized = candidate.replace(/^\.\//u, "");
    const pathname = resolve(packageRoot, normalized);
    if (existsSync(pathname) && statSync(pathname).isFile()) return pathname;
  }
  return null;
}

function implementationSources(packageRoot) {
  return filesUnder(packageRoot).filter((pathname) => {
    const display = relative(packageRoot, pathname).replaceAll("\\", "/");
    if (display === "README.md" || display.endsWith("/README.md")) return false;
    if (display.startsWith("test/") || display.startsWith("tests/")) return false;
    if (display.includes("/test/") || display.includes("/tests/")) return false;
    if (display.endsWith(".test.ts") || display.endsWith(".test.mjs") || display.endsWith(".spec.ts") || display.endsWith(".spec.mjs")) return false;
    return true;
  });
}

function checkM4Architecture({ root = ROOT } = {}) {
  const violations = [];
  const checked = [];
  const missing = [];
  const packageRoot = resolve(root, PACKAGE_PATH);
  const manifestPath = join(packageRoot, "package.json");

  if (!existsSync(packageRoot) || !statSync(packageRoot).isDirectory()) {
    const message = `${PACKAGE_PATH}: reference consumer package is missing`;
    violations.push(message);
    missing.push(message);
    return { ok: false, violations, checked, missing };
  }
  checked.push(PACKAGE_PATH);

  if (!existsSync(manifestPath)) {
    const message = `${PACKAGE_PATH}/package.json: runnable reference package manifest is missing`;
    violations.push(message);
    missing.push(message);
    return { ok: false, violations, checked, missing };
  }
  const manifest = readManifest(manifestPath, violations);
  if (manifest === null) return { ok: false, violations, checked, missing };
  if (typeof manifest.name !== "string" || manifest.name.trim() === "") {
    violations.push(`${PACKAGE_PATH}/package.json: package name is required`);
  }
  if (typeof manifest.scripts?.build !== "string" || manifest.scripts.build.trim() === "") {
    violations.push(`${PACKAGE_PATH}/package.json: reference package must expose a build script`);
  }
  if (typeof manifest.scripts?.test !== "string" || manifest.scripts.test.trim() === "") {
    violations.push(`${PACKAGE_PATH}/package.json: reference package must expose a test script`);
  }

  const entrypoint = resolvePublicEntrypoint(packageRoot, manifest);
  if (entrypoint === null) {
    const message = `${PACKAGE_PATH}: public package entrypoint is missing (exports/main or src/index is required)`;
    violations.push(message);
    missing.push(message);
  } else {
    checked.push(relative(root, entrypoint).replaceAll("\\", "/"));
    const entryDisplay = relative(packageRoot, entrypoint).replaceAll("\\", "/");
    if (entryDisplay.includes("/src/") && packageExportTarget(manifest)?.includes("/src/") && !entryDisplay.startsWith("src/")) {
      violations.push(`${PACKAGE_PATH}/package.json: public export target resolves through an unexpected internal source path`);
    }
  }

  const sourceFiles = implementationSources(packageRoot);
  if (sourceFiles.length === 0) {
    const message = `${PACKAGE_PATH}: production implementation source is missing`;
    violations.push(message);
    missing.push(message);
  }
  for (const pathname of sourceFiles) {
    const display = relative(root, pathname).replaceAll("\\", "/");
    const source = readFileSync(pathname, "utf8");
    const code = stripComments(source);
    const imports = sourceImports(source);
    checked.push(display);

    if (imports.some((specifier) => DATABASE_MODULE.test(specifier))) {
      violations.push(`${display}: direct database/SQL module import is forbidden`);
    }
    if (imports.some((specifier) => SERVER_MODULE.test(specifier))) {
      violations.push(`${display}: Agent Feed server/application implementation import is forbidden`);
    }
    if (imports.some((specifier) => SOURCE_SUBPATH_MODULE.test(specifier))) {
      violations.push(`${display}: private /src subpath import crosses a package boundary`);
    }
    if (SQL.test(code)) {
      violations.push(`${display}: SQL or direct database query code is forbidden`);
    }
    if (RAW_LOG.test(code)) {
      violations.push(`${display}: raw payload/evidence/error/credential logging is forbidden`);
    }
    if (FORBIDDEN_DOMAIN_OUTPUT.test(code)) {
      violations.push(`${display}: reward-rule, canonical-evidence, or promotion output is forbidden`);
    }
  }

  for (const name of dependencyNames(manifest)) {
    if (DATABASE_MODULE.test(name)) violations.push(`${PACKAGE_PATH}/package.json: database dependency ${name} is forbidden`);
    if (SERVER_MODULE.test(name)) violations.push(`${PACKAGE_PATH}/package.json: Agent Feed server/application dependency ${name} is forbidden`);
    if (SOURCE_SUBPATH_MODULE.test(name)) violations.push(`${PACKAGE_PATH}/package.json: private /src dependency ${name} is forbidden`);
  }

  const implementationText = sourceFiles.map((pathname) => stripComments(readFileSync(pathname, "utf8"))).join("\n");
  if (!/finding\.submitted/iu.test(implementationText)) {
    violations.push(`${PACKAGE_PATH}: consumer must handle finding.submitted delivery events`);
  }
  if (!/(?:protocol[_-]?version|protocolVersion)[^\n]{0,80}0\.1/iu.test(implementationText)) {
    violations.push(`${PACKAGE_PATH}: protocol version 0.1 must be pinned in the consumer implementation`);
  }
  if (!/untrusted/iu.test(implementationText) || !/(?:source[_-]?observation|observation)/iu.test(implementationText)) {
    violations.push(`${PACKAGE_PATH}: generic finding must map to an explicitly untrusted source observation`);
  }
  if (!/(?:transport)[^\n]{0,100}(?:dedup|duplicate|idempot|receipt|event[_-]?id)/iu.test(implementationText)) {
    violations.push(`${PACKAGE_PATH}: transport event dedupe/idempotency must be explicit`);
  }
  if (!/(?:semantic)[^\n]{0,100}(?:dedup|duplicate|fingerprint|key)/iu.test(implementationText)) {
    violations.push(`${PACKAGE_PATH}: reward-domain semantic dedupe/fingerprint must be explicit and separate`);
  }
  if (!/(?:submitted[_-]?evidence|evidence)/iu.test(implementationText)) {
    violations.push(`${PACKAGE_PATH}: submitted evidence preservation path is missing`);
  }
  if (
    !/(?:tenant[_-]?id|tenantId)/iu.test(implementationText) ||
    !/(?:consumer[_-]?id|consumerId)/iu.test(implementationText) ||
    !/(?:stream[_-]?id|streamId)/iu.test(implementationText)
  ) {
    violations.push(`${PACKAGE_PATH}: tenant, consumer, and stream scope must be carried by observations and dedupe keys`);
  }

  return { ok: violations.length === 0, violations, checked, missing };
}

export {
  checkM4Architecture,
  filesUnder,
  sourceImports,
  stripComments,
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = checkM4Architecture();
  if (result.ok) {
    console.log(`M4 architecture checks passed (${result.checked.length} paths checked).`);
  } else {
    console.error("M4 architecture checks failed:");
    for (const violation of result.violations) console.error(`- ${violation}`);
    process.exitCode = 1;
  }
}
