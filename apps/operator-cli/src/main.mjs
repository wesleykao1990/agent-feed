import path from "node:path";
import {
  DEFAULT_CONFIG_PATH,
  DEFAULT_RUNTIME_DIR,
  OperatorError,
  REPO_ROOT,
  runDoctor,
  runMcp,
  runPostgres,
  setupRuntime,
} from "./operator.mjs";

export function parseArguments(args, allowedNames) {
  const values = { streams: [] };
  for (let index = 0; index < args.length; index += 1) {
    const item = args[index];
    if (!item?.startsWith("--")) throw new OperatorError("invalid_argument");
    const name = item.slice(2).replaceAll("-", "_");
    if (!allowedNames.has(name)) throw new OperatorError(`unknown_${name}`);
    if (name !== "stream" && Object.hasOwn(values, name)) throw new OperatorError(`duplicate_${name}`);
    if (new Set(["force", "skip_install", "offline", "require_tunnel"]).has(name)) {
      values[name] = true;
      continue;
    }
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) throw new OperatorError(`missing_${name}`);
    index += 1;
    if (name === "stream") values.streams.push(...value.split(",").map((entry) => entry.trim()).filter(Boolean));
    else values[name] = value;
  }
  return values;
}

function output(message) {
  process.stdout.write(`${message}\n`);
}

function help() {
  output(`Agent Feed operator CLI

Usage:
  agent-feed setup [--runtime-dir PATH] [--config PATH] [--database-url URL | --database-url-file PATH]
                   [--tenant ID] [--producer ID] [--stream ID] [--postgres-port PORT]
                   [--skip-install] [--force]
  agent-feed doctor [--config PATH] [--offline] [--require-tunnel]
  agent-feed postgres <up|stop|status> [--runtime-dir PATH]
  agent-feed mcp [--config PATH]

The setup command creates private local configuration and a protocol-clean MCP wrapper.
It does not create OpenAI tunnels, API keys, plugins, or scheduled tasks.`);
}

export async function runCli(argv) {
  const [command = "help", subcommand, ...rest] = argv;
  try {
    if (new Set(["help", "--help", "-h"]).has(command)) {
      help();
      return 0;
    }
    if (command === "setup") {
      const args = parseArguments(
        [subcommand, ...rest].filter(Boolean),
        new Set(["runtime_dir", "config", "database_url", "database_url_file", "tenant", "producer", "stream", "postgres_port", "skip_install", "force"]),
      );
      const result = await setupRuntime({
        runtime_dir: args.runtime_dir,
        config_path: args.config,
        database_url: args.database_url,
        database_url_file: args.database_url_file,
        tenant_id: args.tenant,
        producer_id: args.producer,
        allowed_stream_ids: args.streams.length ? args.streams : undefined,
        postgres_port: args.postgres_port,
        skip_install: args.skip_install,
        force: args.force,
      });
      output("Agent Feed local runtime configured.");
      output(`Config: ${result.config_path}`);
      output(`MCP command: ${result.wrapper_path}`);
      const cliPath = path.join(REPO_ROOT, "bin", "agent-feed");
      if (result.config.postgres.mode === "docker") output(`Next: ${cliPath} postgres up --runtime-dir ${result.runtime_dir}`);
      output(`Then run: ${cliPath} doctor --config ${result.config_path}`);
      output("OpenAI tunnel and ChatGPT plugin setup remain explicit account-side steps.");
      return 0;
    }
    if (command === "doctor") {
      const args = parseArguments([subcommand, ...rest].filter(Boolean), new Set(["config", "offline", "require_tunnel"]));
      const checks = await runDoctor({ config_path: args.config, offline: args.offline, require_tunnel: args.require_tunnel });
      for (const check of checks) output(`${check.ok ? "PASS" : "FAIL"}  ${check.name} — ${check.detail}`);
      return checks.every((check) => check.ok) ? 0 : 1;
    }
    if (command === "postgres") {
      if (!new Set(["up", "stop", "status"]).has(subcommand)) throw new OperatorError("postgres_action_required");
      const args = parseArguments(rest, new Set(["runtime_dir"]));
      return runPostgres(subcommand, args.runtime_dir ?? DEFAULT_RUNTIME_DIR);
    }
    if (command === "mcp") {
      const args = parseArguments([subcommand, ...rest].filter(Boolean), new Set(["config"]));
      return await runMcp(args.config ?? DEFAULT_CONFIG_PATH);
    }
    throw new OperatorError("unknown_command");
  } catch (error) {
    const code = error instanceof OperatorError ? error.code : "internal_error";
    process.stderr.write(`${command === "mcp" ? "agent-feed-mcp launcher failed" : `agent-feed: ${code}`}\n`);
    return 1;
  }
}
