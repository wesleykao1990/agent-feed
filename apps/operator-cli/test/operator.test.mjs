import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  OperatorError,
  composeArguments,
  createConfig,
  createMcpEnvironment,
  mcpDependencySetupPlan,
  renderMcpWrapper,
  renderPostgresEnv,
  runDoctor,
  setupRuntime,
  tunnelHealthArguments,
  tunnelHealthResultOk,
  validateConfig,
} from "../src/operator.mjs";
import { parseArguments } from "../src/main.mjs";

test("setup builds the canonical schema before installing the MCP server", () => {
  const plan = mcpDependencySetupPlan();
  const labels = plan.map((step) => [path.basename(step.args[1]), ...step.args.slice(2)].join(" "));
  assert.equal(labels[0], "schema ci");
  assert.equal(labels[1], "schema run build");
  assert.equal(labels.at(-1), "mcp-server ci");
  assert.ok(labels.indexOf("producer-service ci") < labels.indexOf("mcp-server ci"));
  assert.ok(labels.indexOf("persistence-postgres ci") < labels.indexOf("mcp-server ci"));
  assert.equal(plan[0].error_code, "schema_dependency_install_failed");
  assert.equal(plan[1].error_code, "schema_build_failed");
  assert.ok(plan.slice(2).every((step) => step.error_code === "mcp_dependency_install_failed"));
});

test("docker setup creates scoped credentials without accepting weak or malformed values", () => {
  const config = createConfig({
    tenant_id: "tenant_a",
    producer_id: "producer_a",
    allowed_stream_ids: ["stream.a", "stream.a"],
    producer_secret: "p".repeat(32),
    postgres_password: "d".repeat(32),
    postgres_port: 55432,
  });
  assert.equal(config.postgres.mode, "docker");
  assert.deepEqual(config.allowed_stream_ids, ["stream.a"]);
  assert.match(config.database_url, /^postgresql:\/\/agent_feed:/u);
  assert.throws(() => createConfig({ allowed_stream_ids: ["bad stream"] }), (error) => error instanceof OperatorError && error.code === "invalid_allowed_streams");
  assert.throws(() => createConfig({ allowed_stream_ids: ["Monitoring.Cards"] }), (error) => error instanceof OperatorError && error.code === "invalid_allowed_streams");
  assert.throws(() => createConfig({ producer_secret: "short" }), (error) => error instanceof OperatorError && error.code === "invalid_producer_secret");
});

test("CLI parsing fails closed on unknown and duplicate options", () => {
  const allowed = new Set(["stream", "force"]);
  assert.deepEqual(parseArguments(["--stream", "monitoring.a,monitoring.b", "--force"], allowed), {
    streams: ["monitoring.a", "monitoring.b"],
    force: true,
  });
  assert.throws(() => parseArguments(["--typo", "value"], allowed), /unknown_typo/u);
  assert.throws(() => parseArguments(["--force", "--force"], allowed), /duplicate_force/u);
});

test("external database configuration stays explicit and protocol-pinned", () => {
  const config = createConfig({
    database_url: "postgresql://operator:local-only@db.internal:5432/feed",
    allowed_stream_ids: ["monitoring.cards"],
    producer_secret: "s".repeat(32),
  });
  assert.equal(config.postgres.mode, "external");
  assert.equal(validateConfig(config).format_version, 1);
  assert.throws(() => createConfig({ database_url: "https://example.com/db" }), /invalid_database_url/u);
  assert.throws(() => createConfig({ database_url: "postgresql://db.internal:5432/feed" }), /invalid_database_url/u);
  assert.throws(() => createConfig({ database_url: "" }), /invalid_database_url/u);
});

test("generated files keep secrets out of the MCP wrapper", () => {
  const config = createConfig({ producer_secret: "p".repeat(32), postgres_password: "q".repeat(32) });
  const env = renderPostgresEnv(config);
  assert.match(env, /POSTGRES_PASSWORD=q{32}/u);
  const wrapper = renderMcpWrapper({ cli_path: "/opt/agent feed/bin/agent-feed", config_path: "/opt/agent feed/runtime/config.json" });
  assert.match(wrapper, /^#!\/bin\/sh\nset -eu\nexec /u);
  assert.match(wrapper, / mcp --config /u);
  assert.doesNotMatch(wrapper, /npm|POSTGRES|q{8}|p{8}/u);
});

test("setup writes private runtime state, refuses accidental overwrite, and emits no secret in the wrapper", async () => {
  const runtimeDir = await mkdtemp(path.join(os.tmpdir(), "agent-feed-operator-"));
  try {
    const result = await setupRuntime({
      runtime_dir: runtimeDir,
      skip_install: true,
      producer_secret: "r".repeat(32),
      postgres_password: "t".repeat(32),
      tenant_id: "tenant_custom",
      producer_id: "producer_custom",
      allowed_stream_ids: ["monitoring.custom"],
      postgres_port: 55433,
    });
    const configMode = (await stat(result.config_path)).mode & 0o777;
    const wrapperMode = (await stat(result.wrapper_path)).mode & 0o777;
    assert.equal(configMode, 0o600);
    assert.equal(wrapperMode, 0o700);
    assert.doesNotMatch(await readFile(result.wrapper_path, "utf8"), /r{8}|t{8}/u);
    assert.rejects(() => setupRuntime({ runtime_dir: runtimeDir, skip_install: true }), /runtime_config_exists/u);
    const replaced = await setupRuntime({
      runtime_dir: runtimeDir,
      skip_install: true,
      force: true,
      tenant_id: undefined,
      producer_id: undefined,
      allowed_stream_ids: undefined,
      postgres_port: undefined,
    });
    assert.equal(replaced.config.producer_secret, result.config.producer_secret);
    assert.equal(replaced.config.postgres.password, result.config.postgres.password);
    assert.equal(replaced.config.database_url, result.config.database_url);
    assert.equal(replaced.config.tenant_id, "tenant_custom");
    assert.equal(replaced.config.producer_id, "producer_custom");
    assert.deepEqual(replaced.config.allowed_stream_ids, ["monitoring.custom"]);
    assert.equal(replaced.config.postgres.port, 55433);
  } finally {
    await rm(runtimeDir, { recursive: true, force: true });
  }
});

test("setup reads external database credentials only from a private regular file", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-feed-database-url-"));
  const runtimeDir = path.join(root, "runtime");
  const databaseUrlPath = path.join(root, "database-url");
  try {
    await writeFile(databaseUrlPath, "postgresql://operator:local-only@db.internal:5432/feed\n", { mode: 0o600 });
    const result = await setupRuntime({ runtime_dir: runtimeDir, database_url_file: databaseUrlPath, skip_install: true });
    assert.equal(result.config.postgres.mode, "external");
    assert.equal(result.config.database_url, "postgresql://operator:local-only@db.internal:5432/feed");
    assert.rejects(
      () => setupRuntime({ runtime_dir: path.join(root, "conflict"), database_url: result.config.database_url, database_url_file: databaseUrlPath, skip_install: true }),
      /database_url_source_conflict/u,
    );
    await writeFile(databaseUrlPath, "x".repeat(8193), { mode: 0o600 });
    await assert.rejects(
      () => setupRuntime({ runtime_dir: path.join(root, "oversized"), database_url_file: databaseUrlPath, skip_install: true }),
      /database_url_file_unreadable/u,
    );
    await writeFile(databaseUrlPath, "postgresql://operator:local-only@db.internal:5432/feed\n", { mode: 0o600 });
    if (process.platform !== "win32") {
      await chmod(databaseUrlPath, 0o644);
      await assert.rejects(
        () => setupRuntime({ runtime_dir: path.join(root, "unsafe"), database_url_file: databaseUrlPath, skip_install: true }),
        /database_url_file_permissions_unsafe/u,
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("setup contains generated paths and refuses symlink targets even with force", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-feed-runtime-boundary-"));
  const runtimeDir = path.join(root, "runtime");
  try {
    await assert.rejects(
      () => setupRuntime({ runtime_dir: runtimeDir, config_path: path.join(root, "outside.json"), skip_install: true }),
      /runtime_target_outside_runtime_dir/u,
    );
    await setupRuntime({ runtime_dir: runtimeDir, skip_install: true });
    const target = path.join(root, "protected");
    await writeFile(target, "do-not-overwrite\n");
    await rm(path.join(runtimeDir, "config.json"));
    await symlink(target, path.join(runtimeDir, "config.json"));
    await assert.rejects(() => setupRuntime({ runtime_dir: runtimeDir, skip_install: true, force: true }), /runtime_config_unsafe/u);
    assert.equal(await readFile(target, "utf8"), "do-not-overwrite\n");
    const linkedRuntime = path.join(root, "linked-runtime");
    await symlink(path.join(root, "outside-runtime"), linkedRuntime);
    await assert.rejects(() => setupRuntime({ runtime_dir: linkedRuntime, skip_install: true }), /unsafe_runtime_directory/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("MCP environment removes ambient competing credentials", () => {
  const config = createConfig({
    database_url: "postgresql://operator:local-only@db.internal:5432/feed",
    tenant_id: "tenant_a",
    producer_id: "producer_a",
    allowed_stream_ids: ["stream.a"],
    producer_secret: "z".repeat(32),
  });
  const env = createMcpEnvironment(config, {
    PATH: "/usr/bin",
    SAFE_PARENT: "must-go",
    CONTROL_PLANE_API_KEY: "must-go",
    OPENAI_API_KEY: "must-go",
    DATABASE_URL: "must-go",
    AGENT_FEED_PRODUCER_CREDENTIALS: "must-go",
    AGENT_FEED_MCP_AUTHORIZATION: "must-go",
  });
  assert.equal(env.PATH, "/usr/bin");
  assert.equal(env.SAFE_PARENT, undefined);
  assert.equal(env.CONTROL_PLANE_API_KEY, undefined);
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.DATABASE_URL, undefined);
  assert.equal(env.AGENT_FEED_PRODUCER_CREDENTIALS, undefined);
  assert.equal(env.AGENT_FEED_MCP_AUTHORIZATION, undefined);
  assert.equal(env.AGENT_FEED_PRODUCER_SECRET, "z".repeat(32));
  assert.equal(env.AGENT_FEED_MCP_PRODUCER_SECRET, "z".repeat(32));
});

test("offline doctor validates private configuration and detects insecure permissions", async () => {
  const runtimeDir = await mkdtemp(path.join(os.tmpdir(), "agent-feed-doctor-"));
  try {
    const result = await setupRuntime({ runtime_dir: runtimeDir, skip_install: true, database_url: "postgresql://operator:local-only@127.0.0.1:5432/feed" });
    const first = await runDoctor({ config_path: result.config_path, offline: true });
    assert.equal(first.every((check) => check.ok), true);
    if (process.platform !== "win32") {
      await chmod(result.config_path, 0o644);
      const second = await runDoctor({ config_path: result.config_path, offline: true });
      assert.equal(second.find((check) => check.name === "private runtime config")?.ok, false);
      await chmod(result.config_path, 0o600);
    }
    await writeFile(result.config_path, "x".repeat(65537), { mode: 0o600 });
    const oversized = await runDoctor({ config_path: result.config_path, offline: true });
    assert.equal(oversized.some((check) => check.detail === "runtime_config_unsafe"), true);
  } finally {
    await rm(runtimeDir, { recursive: true, force: true });
  }
});

test("tunnel doctor fails closed unless PID, endpoints, and an authenticated poll are healthy", async () => {
  const runtimeDir = await mkdtemp(path.join(os.tmpdir(), "agent-feed-tunnel-doctor-"));
  try {
    const result = await setupRuntime({ runtime_dir: runtimeDir, skip_install: true });
    const missingPaths = await runDoctor({
      config_path: result.config_path,
      offline: true,
      require_tunnel: true,
      command_exists: () => true,
    });
    assert.equal(missingPaths.find((check) => check.name === "tunnel runtime health")?.ok, false);

    const healthy = await runDoctor({
      config_path: result.config_path,
      offline: true,
      require_tunnel: true,
      tunnel_url_file: path.join(runtimeDir, "health.url"),
      tunnel_pid_file: path.join(runtimeDir, "tunnel.pid"),
      command_exists: () => true,
      tunnel_health_probe: () => true,
    });
    assert.equal(healthy.every((check) => check.ok), true);

    const unhealthy = await runDoctor({
      config_path: result.config_path,
      offline: true,
      require_tunnel: true,
      tunnel_url_file: path.join(runtimeDir, "health.url"),
      tunnel_pid_file: path.join(runtimeDir, "tunnel.pid"),
      command_exists: () => true,
      tunnel_health_probe: () => false,
    });
    assert.equal(unhealthy.find((check) => check.name === "tunnel runtime health")?.ok, false);
  } finally {
    await rm(runtimeDir, { recursive: true, force: true });
  }
});

test("tunnel health command and JSON acceptance are exact and fail closed", () => {
  assert.deepEqual(tunnelHealthArguments("./health.url", "./tunnel.pid").slice(-2), ["--require-control-plane-poll", "--json"]);
  const complete = {
    status: 0,
    stdout: JSON.stringify({
      result: "ok",
      process: { running: true },
      healthz: { ok: true },
      readyz: { ok: true },
      control_plane_poll: { ok: true },
    }),
  };
  assert.equal(tunnelHealthResultOk(complete), true);
  assert.equal(tunnelHealthResultOk({ ...complete, stdout: "not json" }), false);
  assert.equal(tunnelHealthResultOk({ ...complete, stdout: JSON.stringify({ ...JSON.parse(complete.stdout), readyz: { ok: false } }) }), false);
  assert.equal(tunnelHealthResultOk({ ...complete, status: 1 }), false);
});

test("Docker lifecycle preserves the named volume and never removes data", () => {
  const args = composeArguments("up", "/tmp/operator-runtime");
  assert.deepEqual(args.slice(-3), ["up", "-d", "postgres"]);
  assert.deepEqual(composeArguments("stop", "/tmp/operator-runtime").slice(-2), ["stop", "postgres"]);
  assert.equal(composeArguments("status", "/tmp/operator-runtime").includes("down"), false);
  assert.equal(composeArguments("stop", "/tmp/operator-runtime").includes("--volumes"), false);
});
