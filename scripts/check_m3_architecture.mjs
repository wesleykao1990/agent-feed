#!/usr/bin/env node

/**
 * Static boundary checks for Milestone 3.
 *
 * This checker is intentionally stricter than the older milestone checks:
 * missing M3 implementation roots are failures, not deferred skips.  The
 * M3 gate is meant to catch an apparently green package set that still has a
 * README-only MCP server, generated-type-only SDK, or placeholder adapter.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE_EXTENSIONS = new Set([".js", ".mjs", ".cjs", ".ts", ".mts", ".cts", ".py"]);
const PACKAGE_BOUNDARIES = [
  { label: "MCP server", path: "apps/mcp-server", kind: "typescript", requirePackage: true },
  { label: "TypeScript SDK", path: "packages/sdk/typescript", kind: "typescript", requirePackage: true },
  { label: "Python SDK", path: "packages/sdk/python", kind: "python", requirePackage: false },
  { label: "REST adapter", path: "packages/adapters/rest", kind: "typescript", requirePackage: true },
  { label: "local-file adapter", path: "packages/adapters/local-file", kind: "typescript", requirePackage: true },
  { label: "generic-webhook adapter", path: "packages/adapters/generic-webhook", kind: "typescript", requirePackage: true },
  { label: "Claude hook adapter", path: "packages/adapters/claude-hook", kind: "typescript", requirePackage: true },
  { label: "ChatGPT manual-export adapter", path: "packages/adapters/chatgpt-manual-export", kind: "typescript", requirePackage: true },
];

const DB_IMPORT = /(?:@agent-feed\/(?:persistence-postgres|postgres|database)(?:\/|$)|(?:^|["'])\s*(?:pg|postgres|postgresjs|knex|kysely|drizzle-orm|sequelize)(?:\/|["'])|(?:^|\s)(?:import|from)\s+(?:pg|postgres|psycopg|asyncpg|sqlalchemy)(?:\s|$))/iu;
const DB_PACKAGE = /^(?:@agent-feed\/(?:persistence-postgres|postgres|database)|pg|postgres|postgresjs|psycopg|asyncpg|sqlalchemy|knex|kysely|drizzle-orm|sequelize)(?:\/|$)/iu;
const SERVER_INTERNAL_IMPORT = /(?:@agent-feed\/(?:api|delivery-api|persistence-postgres)(?:\/|$)|(?:\.\.?\/)+(?:apps|packages)\/(?:api|delivery-api|persistence-postgres)(?:\/|$)|apps\/(?:api|delivery-api)\/src(?:\/|$))/iu;
const SOURCE_SUBPATH_IMPORT = /(?:@agent-feed\/[^"'\s]+\/src(?:\/|$)|(?:\.\.?\/)+[^"'\s]*\/src(?:\/|$))/iu;
const REWARD_IMPORT = /(?:rewards?-optimizer|paypay|point(?:s|ing)?|reward(?:s|ing)?)/iu;
const SQL = /\b(?:select\s+.+\s+from|insert\s+into|update\s+.+\s+set|delete\s+from|create\s+table|alter\s+table|drop\s+table)\b|\.\s*(?:query|execute)\s*\(/iu;
const RAW_ERROR_LOG = /(?:console\.(?:debug|info|log|warn|error)|\bprint)\s*\([^\n]*(?:\berror\b|\bexception\b|\bexc\b|authorization|bearer|secret|token|payload|excerpt)[^\n]*\)/iu;

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
  const imports = [];
  const code = stripComments(source);
  const modulePatterns = [
    /^\s*import\s+(?:type\s+)?(?:[\s\S]*?\s+from\s*)?["']([^"']+)["']/gmu,
    /\bimport\s+(?:type\s+)?(?:[^;\n]*?\s+from\s*)?["']([^"']+)["']/gu,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/gu,
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/gu,
    /\bexport\s+(?:type\s+)?[^;\n]*?\s+from\s*["']([^"']+)["']/gu,
    /^\s*from\s+["']?([A-Za-z_][A-Za-z0-9_.-]*)["']?\s+import\b/gmu,
    /^\s*import\s+([A-Za-z_][A-Za-z0-9_.-]*)/gmu,
  ];
  for (const pattern of modulePatterns) {
    for (const match of code.matchAll(pattern)) imports.push(match[1]);
  }
  /*
   * The parser intentionally returns module specifiers only.  It must not
   * treat a domain-shaped field, prose, or a comment in a generated/type
   * surface as a forbidden dependency edge.
  */
  return [...new Set(imports.filter((specifier) => typeof specifier === "string"))];
}

function readJson(pathname, violations, display) {
  try {
    return JSON.parse(readFileSync(pathname, "utf8"));
  } catch (error) {
    violations.push(`${display}: package manifest is not valid JSON (${error instanceof Error ? error.message : "parse error"})`);
    return null;
  }
}

function packageManifest(root, boundary, violations) {
  const pathname = resolve(root, boundary.path, "package.json");
  if (!existsSync(pathname)) {
    if (boundary.requirePackage) violations.push(`${boundary.path}: missing package.json for M3 package`);
    return null;
  }
  return readJson(pathname, violations, relative(root, pathname));
}

function declaredDependencies(manifest) {
  return Object.entries({
    ...manifest?.dependencies,
    ...manifest?.devDependencies,
    ...manifest?.peerDependencies,
    ...manifest?.optionalDependencies,
  });
}

function declaredDependencyNames(root, boundary, manifest) {
  const names = declaredDependencies(manifest).map(([name]) => name);
  if (boundary.kind !== "python") return names;
  const pyproject = resolve(root, boundary.path, "pyproject.toml");
  if (!existsSync(pyproject)) return names;
  // This deliberately reads only quoted dependency tokens, not prose or
  // comments. TOML dependency arrays use the same quoted package spelling as
  // the package managers supported by this SDK.
  for (const match of readFileSync(pyproject, "utf8").matchAll(/["']([^"']+)["']/gu)) {
    const name = match[1].split(/[<>=!~\[]/u, 1)[0]?.trim();
    if (name) names.push(name);
  }
  return names;
}

function implementationSources(root, boundary) {
  const base = resolve(root, boundary.path);
  const all = filesUnder(base);
  return all.filter((pathname) => {
    const display = relative(base, pathname).replaceAll("\\", "/");
    if (display.startsWith("test/") || display.startsWith("tests/") || display.includes("/test/") || display.includes("/tests/") || display.endsWith(".test.ts") || display.endsWith(".test.mjs")) return false;
    if (boundary.kind === "python" && (display.startsWith("generated/") || display === "agent_feed/generated/protocol.py" || display === "agent_feed/generated/__init__.py")) return false;
    if (display.endsWith("/README.md") || display === "README.md") return false;
    return true;
  });
}

function checkSkills(root, violations) {
  const skill = resolve(root, "skills/chatgpt/SKILL.md");
  if (!existsSync(skill)) {
    violations.push("skills/chatgpt/SKILL.md: required Scheduled Task capability guidance is missing");
    return;
  }
  const source = readFileSync(skill, "utf8");
  if (!/capabilit/iu.test(source) || !/run[- ]bundle/iu.test(source) || !/local[- ]file/iu.test(source)) {
    violations.push("skills/chatgpt/SKILL.md: must describe capability-gated direct submission and the run-bundle/local-file fallback");
  }
  if (/scheduled\s+tasks?[^.\n]*(?:webhook|automatic\s+(?:outbound|ingestion|submission))/iu.test(source)
    && !/(?:must\s+not|cannot|only\s+when|when\s+(?:the\s+)?tools?\s+are\s+unavailable|capabilit)/iu.test(source)) {
    violations.push("skills/chatgpt/SKILL.md: appears to claim Scheduled Task automation without an explicit capability gate");
  }
}

function checkM3Architecture({ root = ROOT } = {}) {
  const violations = [];
  const checked = [];
  const missing = [];
  const sourceByBoundary = new Map();

  for (const boundary of PACKAGE_BOUNDARIES) {
    const base = resolve(root, boundary.path);
    if (!existsSync(base)) {
      const message = `${boundary.path}: required M3 boundary is missing`;
      violations.push(message);
      missing.push(message);
      continue;
    }

    const manifest = packageManifest(root, boundary, violations);
    const implementation = implementationSources(root, boundary).map((pathname) => ({
      pathname,
      display: relative(root, pathname).replaceAll("\\", "/"),
      source: readFileSync(pathname, "utf8"),
    }));
    sourceByBoundary.set(boundary.path, implementation);
    checked.push(boundary.path);

    if (implementation.length === 0) {
      const message = `${boundary.path}: implementation source is missing (README/generated-only package is not M3 evidence)`;
      violations.push(message);
      missing.push(message);
    }

    if (boundary.requirePackage && manifest) {
      if (typeof manifest.scripts?.test !== "string" || manifest.scripts.test.trim() === "") {
        violations.push(`${boundary.path}/package.json: M3 package must expose a test script`);
      }
      if (typeof manifest.scripts?.build !== "string" || manifest.scripts.build.trim() === "") {
        violations.push(`${boundary.path}/package.json: M3 TypeScript package must expose a build script`);
      }
    }

    if (boundary.path === "apps/mcp-server") {
      if (manifest?.dependencies?.["@modelcontextprotocol/server"] !== "2.0.0") {
        violations.push("apps/mcp-server/package.json: official @modelcontextprotocol/server dependency must be pinned to 2.0.0");
      }
    }

    const mcpMain = implementation.find(({ display }) => display === "apps/mcp-server/src/main.ts");
    const mcpCompositionOwnsDatabase = boundary.path === "apps/mcp-server"
      && mcpMain !== undefined
      && sourceImports(mcpMain.source).some((specifier) => DB_PACKAGE.test(specifier));
    for (const name of declaredDependencyNames(root, boundary, manifest)) {
      // The MCP executable composition root is the one deliberate exception:
      // it is allowed to construct Postgres persistence and inject the public
      // producer service.  Tool handlers and the rest of the M3 packages are
      // still forbidden from carrying that dependency.
      const mcpCompositionDependency = mcpCompositionOwnsDatabase && name === "@agent-feed/persistence-postgres";
      if (DB_PACKAGE.test(name) && !mcpCompositionDependency) violations.push(`${boundary.path}/package.json: database dependency ${name} is forbidden in M3 boundary`);
      if ((SERVER_INTERNAL_IMPORT.test(name) && !mcpCompositionDependency) || SOURCE_SUBPATH_IMPORT.test(name)) {
        violations.push(`${boundary.path}/package.json: server/source-subpath dependency ${name} crosses a private boundary`);
      }
      if (REWARD_IMPORT.test(name)) {
        violations.push(`${boundary.path}/package.json: consumer/rewards dependency ${name} is forbidden in a generic M3 boundary`);
      }
    }

    for (const { display, source } of implementation) {
      const imports = sourceImports(source);
      const mcpCompositionRoot = boundary.path === "apps/mcp-server" && display === "apps/mcp-server/src/main.ts";
      if ((DB_IMPORT.test(source) || imports.some((specifier) => DB_PACKAGE.test(specifier))) && !mcpCompositionRoot) {
        violations.push(`${display}: M3 boundary imports a database implementation/driver`);
      }
      if ((SERVER_INTERNAL_IMPORT.test(source) || imports.some((specifier) => SERVER_INTERNAL_IMPORT.test(specifier))) && !mcpCompositionRoot) {
        violations.push(`${display}: M3 boundary imports a server/application implementation rather than a public port`);
      }
      if (SOURCE_SUBPATH_IMPORT.test(source) || imports.some((specifier) => SOURCE_SUBPATH_IMPORT.test(specifier))) {
        violations.push(`${display}: M3 boundary imports another package's private /src subpath`);
      }
      if (SQL.test(source)) violations.push(`${display}: M3 boundary contains SQL or direct database query code`);
      if (imports.some((specifier) => REWARD_IMPORT.test(specifier)) && !/README|generated/iu.test(display)) {
        violations.push(`${display}: M3 generic boundary imports a consumer/rewards domain`);
      }
      if (RAW_ERROR_LOG.test(source)) {
        violations.push(`${display}: raw errors, credentials, or payloads may be logged; use a redacted diagnostic`);
      }
    }
  }

  const apiEntry = resolve(root, "apps/api/src/index.ts");
  if (!existsSync(apiEntry)) {
    violations.push("apps/api/src/index.ts: REST producer application entrypoint is missing");
  } else {
    const source = readFileSync(apiEntry, "utf8");
    checked.push("apps/api/src/index.ts");
    if (!/@agent-feed\/producer-service(?:["'/]|$)/u.test(source)) {
      violations.push("apps/api/src/index.ts: REST adapter does not import the public producer-service boundary");
    }
    if (/@agent-feed\/persistence-postgres|\b(?:pg|postgres|postgresjs)\b/iu.test(source) || SQL.test(source)) {
      violations.push("apps/api/src/index.ts: REST request adapter contains a persistence/SQL dependency");
    }
  }

  const mcpSources = sourceByBoundary.get("apps/mcp-server") ?? [];
  if (mcpSources.length > 0 && !mcpSources.some(({ source }) => /@agent-feed\/producer-service(?:["'/]|$)/u.test(source))) {
    violations.push("apps/mcp-server: MCP implementation must delegate through @agent-feed/producer-service");
  }
  if (mcpSources.length > 0) {
    if (!mcpSources.some(({ source }) => sourceImports(source).some((specifier) => specifier === "@modelcontextprotocol/server"))) {
      violations.push("apps/mcp-server: MCP implementation must construct the official @modelcontextprotocol/server public API");
    }
    if (!mcpSources.some(({ source }) => sourceImports(source).some((specifier) => specifier === "@modelcontextprotocol/server/stdio"))) {
      violations.push("apps/mcp-server: MCP production stdio must use @modelcontextprotocol/server/stdio");
    }
    const mcpMain = mcpSources.find(({ display }) => display === "apps/mcp-server/src/main.ts");
    if (mcpMain === undefined) {
      violations.push("apps/mcp-server/src/main.ts: production MCP entrypoint is required");
    } else {
      const imports = sourceImports(mcpMain.source);
      if (!imports.includes("@modelcontextprotocol/server/stdio") || !/\bserveStdio\s*\(/u.test(mcpMain.source)) {
        violations.push("apps/mcp-server/src/main.ts: production MCP entrypoint must call official serveStdio");
      }
      if (!imports.includes("./sdk.ts") || !/\bcreateOfficialMcpServer\s*\(/u.test(mcpMain.source)) {
        violations.push("apps/mcp-server/src/main.ts: production MCP entrypoint must construct the official SDK server");
      }
      if (imports.includes("./server.ts")) {
        violations.push("apps/mcp-server/src/main.ts: production MCP entrypoint must not import the internal legacy facade");
      }
    }
  }
  const serviceBoundaries = [
    "packages/adapters/local-file",
    "packages/adapters/generic-webhook",
    "packages/adapters/claude-hook",
    "packages/adapters/chatgpt-manual-export",
  ];
  for (const boundary of serviceBoundaries) {
    const sources = sourceByBoundary.get(boundary) ?? [];
    if (sources.length > 0 && !sources.some(({ source }) => /@agent-feed\/producer-service(?:["'/]|$)/u.test(source))) {
      violations.push(`${boundary}: producer adapter must delegate through @agent-feed/producer-service`);
    }
  }

  const tsSources = sourceByBoundary.get("packages/sdk/typescript") ?? [];
  if (tsSources.length > 0) {
    const text = tsSources.map(({ source }) => source).join("\n");
    if (!/(?:beginRun|begin_run)/u.test(text) || !/(?:submitBatch|submit_batch)/u.test(text) || !/(?:completeRun|complete_run)/u.test(text)) {
      violations.push("packages/sdk/typescript: producer lifecycle surface is incomplete");
    }
    if (!/(?:acknowledge|acknowledg|pull|replay|dead.?letter)/iu.test(text)) {
      violations.push("packages/sdk/typescript: consumer surface is incomplete");
    }
  }
  const pySources = sourceByBoundary.get("packages/sdk/python") ?? [];
  if (pySources.length > 0) {
    const text = pySources.map(({ source }) => source).join("\n");
    if (!/(?:begin_run|beginRun)/u.test(text) || !/(?:submit_batch|submitBatch)/u.test(text) || !/(?:complete_run|completeRun)/u.test(text)) {
      violations.push("packages/sdk/python: producer lifecycle surface is incomplete");
    }
    if (!/(?:acknowledge|acknowledg|pull|replay|dead.?letter)/iu.test(text)) {
      violations.push("packages/sdk/python: consumer surface is incomplete");
    }
  }

  checkSkills(root, violations);
  return { ok: violations.length === 0, violations, checked, missing };
}

export { checkM3Architecture, filesUnder, sourceImports };

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = checkM3Architecture();
  if (result.ok) {
    console.log(`M3 architecture checks passed (${result.checked.length} boundaries checked).`);
  } else {
    console.error("M3 architecture checks failed:");
    for (const violation of result.violations) console.error(`- ${violation}`);
    process.exitCode = 1;
  }
}
