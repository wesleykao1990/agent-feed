import { spawn, spawnSync } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, chmod, lstat, mkdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createConfig, OperatorError, renderMcpWrapper, renderPostgresEnv, validateConfig, validateDatabaseUrl } from "./config.mjs";

export {
  CONFIG_FORMAT_VERSION,
  createConfig,
  generateSecret,
  OperatorError,
  renderMcpWrapper,
  renderPostgresEnv,
  shellQuote,
  validateConfig,
  validateDatabaseUrl,
} from "./config.mjs";

export const REPO_ROOT = path.resolve(fileURLToPath(new URL("../../../", import.meta.url)));
export const DEFAULT_RUNTIME_DIR = path.join(REPO_ROOT, ".runtime", "operator");
export const DEFAULT_CONFIG_PATH = path.join(DEFAULT_RUNTIME_DIR, "config.json");
const SAFE_CHILD_ENV_NAMES = [
  "PATH",
  "HOME",
  "USERPROFILE",
  "TMPDIR",
  "TEMP",
  "TMP",
  "LANG",
  "LC_ALL",
  "TZ",
  "SYSTEMROOT",
  "WINDIR",
  "COMSPEC",
  "PATHEXT",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
  "PGSSLMODE",
  "PGSSLROOTCERT",
  "PGSSLCERT",
  "PGSSLKEY",
];

async function writePrivateFile(filePath, contents, { force = false, executable = false } = {}) {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  try {
    const existing = await lstat(filePath);
    if (existing.isSymbolicLink()) throw new OperatorError("unsafe_runtime_target");
    if (!force) throw new OperatorError("runtime_config_exists");
  } catch (error) {
    if (error instanceof OperatorError) throw error;
    if (error?.code !== "ENOENT") throw error;
  }
  await writeFile(filePath, contents, { encoding: "utf8", mode: executable ? 0o700 : 0o600, flag: force ? "w" : "wx" });
  await chmod(filePath, executable ? 0o700 : 0o600);
}

function requireRuntimeTarget(runtimeDir, target) {
  const relative = path.relative(runtimeDir, target);
  if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new OperatorError("runtime_target_outside_runtime_dir");
  }
}

async function readPrivateDatabaseUrl(filePath) {
  const resolved = path.resolve(filePath);
  const fileStat = await lstat(resolved).catch(() => null);
  if (!fileStat?.isFile() || fileStat.isSymbolicLink() || fileStat.size === 0 || fileStat.size > 8192) {
    throw new OperatorError("database_url_file_unreadable");
  }
  if (process.platform !== "win32" && (fileStat.mode & 0o077) !== 0) {
    throw new OperatorError("database_url_file_permissions_unsafe");
  }
  return validateDatabaseUrl((await readFile(resolved, "utf8")).trim());
}

async function assertWritableTargets(paths, force) {
  for (const target of paths) {
    try {
      const existing = await lstat(target);
      if (existing.isSymbolicLink()) throw new OperatorError("unsafe_runtime_target");
      if (!force) throw new OperatorError("runtime_config_exists");
    } catch (error) {
      if (error instanceof OperatorError) throw error;
      if (error?.code !== "ENOENT") throw error;
    }
  }
}

async function assertRuntimeTreeSafe(runtimeDir, targets) {
  const runtimeStat = await lstat(runtimeDir).catch(() => null);
  if (runtimeStat?.isSymbolicLink()) throw new OperatorError("unsafe_runtime_directory");
  for (const target of targets) {
    const relative = path.relative(runtimeDir, target);
    const parts = relative.split(path.sep).filter(Boolean);
    let current = runtimeDir;
    for (const part of parts.slice(0, -1)) {
      current = path.join(current, part);
      const currentStat = await lstat(current).catch(() => null);
      if (currentStat?.isSymbolicLink()) throw new OperatorError("unsafe_runtime_directory");
    }
  }
}

function npmCommand() {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

export async function setupRuntime(options = {}) {
  const runtimeDir = path.resolve(options.runtime_dir ?? DEFAULT_RUNTIME_DIR);
  const configPath = path.resolve(options.config_path ?? path.join(runtimeDir, "config.json"));
  const wrapperPath = path.join(runtimeDir, "bin", "agent-feed-mcp");
  const postgresEnvPath = path.join(runtimeDir, "postgres.env");
  requireRuntimeTarget(runtimeDir, configPath);
  await assertRuntimeTreeSafe(runtimeDir, [configPath, wrapperPath, postgresEnvPath]);
  if (options.database_url !== undefined && options.database_url_file !== undefined) {
    throw new OperatorError("database_url_source_conflict");
  }
  const databaseUrl = options.database_url_file ? await readPrivateDatabaseUrl(options.database_url_file) : options.database_url;
  let previous;
  if (options.force) {
    try {
      previous = await loadConfig(configPath);
    } catch (error) {
      if (!(error instanceof OperatorError) || error.code !== "runtime_config_missing") throw error;
    }
  }
  const preserved = previous
    ? {
        tenant_id: previous.tenant_id,
        producer_id: previous.producer_id,
        allowed_stream_ids: previous.allowed_stream_ids,
        producer_secret: previous.producer_secret,
        ...(previous.postgres.mode === "external"
          ? { database_url: previous.database_url }
          : {
              postgres_user: previous.postgres.user,
              postgres_database: previous.postgres.database,
              postgres_port: previous.postgres.port,
              postgres_password: previous.postgres.password,
            }),
      }
    : {};
  const explicit = Object.fromEntries(Object.entries(options).filter(([, value]) => value !== undefined));
  const config = createConfig({ ...preserved, ...explicit, database_url: databaseUrl ?? preserved.database_url });
  await assertWritableTargets(
    [configPath, wrapperPath, ...(config.postgres.mode === "docker" ? [postgresEnvPath] : [])],
    options.force,
  );
  if (!options.skip_install) {
    const install = spawnSync(npmCommand(), ["--prefix", path.join(REPO_ROOT, "apps", "mcp-server"), "ci"], {
      cwd: REPO_ROOT,
      stdio: "inherit",
    });
    if (install.status !== 0) throw new OperatorError("mcp_dependency_install_failed");
  }
  await mkdir(runtimeDir, { recursive: true, mode: 0o700 });
  await chmod(runtimeDir, 0o700);
  await mkdir(path.dirname(configPath), { recursive: true, mode: 0o700 });
  await chmod(path.dirname(configPath), 0o700);
  await mkdir(path.dirname(wrapperPath), { recursive: true, mode: 0o700 });
  await chmod(path.dirname(wrapperPath), 0o700);
  await writePrivateFile(configPath, `${JSON.stringify(config, null, 2)}\n`, { force: options.force });
  if (config.postgres.mode === "docker") {
    await writePrivateFile(postgresEnvPath, renderPostgresEnv(config), { force: options.force });
  } else if (options.force) {
    await unlink(postgresEnvPath).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });
  }
  const cliPath = path.join(REPO_ROOT, "bin", "agent-feed");
  await writePrivateFile(wrapperPath, renderMcpWrapper({ cli_path: cliPath, config_path: configPath }), {
    force: options.force,
    executable: true,
  });
  return { runtime_dir: runtimeDir, config_path: configPath, wrapper_path: wrapperPath, postgres_env_path: config.postgres.mode === "docker" ? postgresEnvPath : null, config };
}

export async function loadConfig(configPath = DEFAULT_CONFIG_PATH) {
  const resolved = path.resolve(configPath);
  let raw;
  try {
    const configStat = await lstat(resolved);
    if (!configStat.isFile() || configStat.isSymbolicLink() || configStat.size === 0 || configStat.size > 65536) {
      throw new OperatorError("runtime_config_unsafe");
    }
    if (process.platform !== "win32" && (configStat.mode & 0o077) !== 0) {
      throw new OperatorError("runtime_config_permissions_unsafe");
    }
    raw = await readFile(resolved, "utf8");
  } catch (error) {
    if (error instanceof OperatorError) throw error;
    throw new OperatorError("runtime_config_missing");
  }
  try {
    return validateConfig(JSON.parse(raw));
  } catch (error) {
    if (error instanceof OperatorError) throw error;
    throw new OperatorError("invalid_config_json");
  }
}

export function createMcpEnvironment(config, baseEnvironment = process.env) {
  const checked = validateConfig(config);
  const env = {};
  for (const name of SAFE_CHILD_ENV_NAMES) {
    if (typeof baseEnvironment[name] === "string") env[name] = baseEnvironment[name];
  }
  return {
    ...env,
    AGENT_FEED_DATABASE_URL: checked.database_url,
    AGENT_FEED_TENANT_ID: checked.tenant_id,
    AGENT_FEED_PRODUCER_ID: checked.producer_id,
    AGENT_FEED_ALLOWED_STREAMS: checked.allowed_stream_ids.join(","),
    AGENT_FEED_PRODUCER_SECRET: checked.producer_secret,
    AGENT_FEED_MCP_PRODUCER_SECRET: checked.producer_secret,
  };
}

export async function runMcp(configPath = DEFAULT_CONFIG_PATH) {
  const config = await loadConfig(configPath);
  const child = spawn(process.execPath, ["--experimental-strip-types", path.join(REPO_ROOT, "apps", "mcp-server", "src", "main.ts")], {
    cwd: path.join(REPO_ROOT, "apps", "mcp-server"),
    env: createMcpEnvironment(config),
    stdio: "inherit",
  });
  return await new Promise((resolve, reject) => {
    const forwardSignal = (signal) => {
      if (!child.killed) child.kill(signal);
    };
    const onSigint = () => forwardSignal("SIGINT");
    const onSigterm = () => forwardSignal("SIGTERM");
    const cleanup = () => {
      process.off("SIGINT", onSigint);
      process.off("SIGTERM", onSigterm);
    };
    process.on("SIGINT", onSigint);
    process.on("SIGTERM", onSigterm);
    child.once("error", () => {
      cleanup();
      reject(new OperatorError("mcp_process_start_failed"));
    });
    child.once("exit", (code, signal) => {
      cleanup();
      resolve(code ?? (signal ? 1 : 0));
    });
  });
}

function commandExists(command) {
  const result = spawnSync(command, ["--version"], { stdio: "ignore" });
  return result.status === 0;
}

async function databaseReachable(databaseUrl, timeoutMs = 2000) {
  const parsed = new URL(databaseUrl);
  const port = Number(parsed.port || 5432);
  return await new Promise((resolve) => {
    const socket = createConnection({ host: parsed.hostname, port });
    const finish = (value) => {
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

export async function runDoctor(options = {}) {
  const checks = [];
  const record = (name, ok, detail) => checks.push({ name, ok, detail });
  record("Node.js 22+", Number(process.versions.node.split(".")[0]) >= 22, process.versions.node);
  const configPath = path.resolve(options.config_path ?? DEFAULT_CONFIG_PATH);
  let config;
  try {
    const configStat = await stat(configPath);
    const privateMode = process.platform === "win32" || (configStat.mode & 0o077) === 0;
    record("private runtime config", configStat.isFile() && privateMode, privateMode ? "mode is private" : "group/other access is set");
    config = await loadConfig(configPath);
    record("runtime config schema", true, "valid");
  } catch (error) {
    record("runtime config", false, error instanceof OperatorError ? error.code : "unreadable");
  }
  try {
    await access(path.join(REPO_ROOT, "apps", "mcp-server", "node_modules"), fsConstants.R_OK);
    await access(path.join(REPO_ROOT, "apps", "mcp-server", "bin", "agent-feed-mcp-stdio"), fsConstants.X_OK);
    record("MCP dependencies and launcher", true, "installed");
  } catch {
    record("MCP dependencies and launcher", false, "run agent-feed setup");
  }
  if (!options.offline && config) {
    record("PostgreSQL socket", await databaseReachable(config.database_url), "configured host and port");
  }
  if (options.require_tunnel) record("tunnel-client", commandExists("tunnel-client"), "required for private ChatGPT setup");
  return checks;
}

export function composeArguments(action, runtimeDir = DEFAULT_RUNTIME_DIR) {
  const envFile = path.join(path.resolve(runtimeDir), "postgres.env");
  const base = ["compose", "--env-file", envFile, "-f", path.join(REPO_ROOT, "compose.yaml")];
  if (action === "up") return [...base, "up", "-d", "postgres"];
  if (action === "stop") return [...base, "stop", "postgres"];
  if (action === "status") return [...base, "ps", "postgres"];
  throw new OperatorError("unsupported_postgres_action");
}

export function runPostgres(action, runtimeDir = DEFAULT_RUNTIME_DIR) {
  const result = spawnSync("docker", composeArguments(action, runtimeDir), { cwd: REPO_ROOT, stdio: "inherit" });
  if (result.status !== 0) throw new OperatorError("docker_compose_failed");
  return 0;
}
