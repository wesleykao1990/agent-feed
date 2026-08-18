import { randomBytes } from "node:crypto";
import path from "node:path";

export const CONFIG_FORMAT_VERSION = 1;

const ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/u;
const STREAM_ID_PATTERN = /^[a-z0-9][a-z0-9._-]+$/u;
const SAFE_ENV_PATTERN = /^[A-Za-z0-9._:-]+$/u;

export class OperatorError extends Error {
  constructor(code) {
    super(code);
    this.name = "OperatorError";
    this.code = code;
  }
}

export function generateSecret() {
  return randomBytes(32).toString("base64url");
}

function requireId(value, code) {
  if (typeof value !== "string" || !ID_PATTERN.test(value)) throw new OperatorError(code);
  return value;
}

function requireStreams(value) {
  const streams = Array.isArray(value) ? value : [];
  if (streams.length === 0 || streams.some((stream) => typeof stream !== "string" || !STREAM_ID_PATTERN.test(stream))) {
    throw new OperatorError("invalid_allowed_streams");
  }
  return [...new Set(streams)];
}

export function validateDatabaseUrl(value) {
  if (typeof value !== "string" || value.length === 0 || /[\r\n]/u.test(value)) throw new OperatorError("invalid_database_url");
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new OperatorError("invalid_database_url");
  }
  if (!new Set(["postgres:", "postgresql:"]).has(parsed.protocol) || !parsed.username || !parsed.hostname || !parsed.pathname.slice(1)) {
    throw new OperatorError("invalid_database_url");
  }
  return value;
}

export function validateConfig(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new OperatorError("invalid_config");
  const config = value;
  if (config.format_version !== CONFIG_FORMAT_VERSION) throw new OperatorError("unsupported_config_version");
  const producerSecret = typeof config.producer_secret === "string" ? config.producer_secret : "";
  if (producerSecret.length < 32 || /[\r\n]/u.test(producerSecret)) throw new OperatorError("invalid_producer_secret");
  const postgres = config.postgres;
  if (postgres === null || typeof postgres !== "object" || Array.isArray(postgres)) throw new OperatorError("invalid_postgres_config");
  if (!new Set(["docker", "external"]).has(postgres.mode)) throw new OperatorError("invalid_postgres_mode");
  return {
    format_version: CONFIG_FORMAT_VERSION,
    database_url: validateDatabaseUrl(config.database_url),
    tenant_id: requireId(config.tenant_id, "invalid_tenant_id"),
    producer_id: requireId(config.producer_id, "invalid_producer_id"),
    allowed_stream_ids: requireStreams(config.allowed_stream_ids),
    producer_secret: producerSecret,
    postgres: { ...postgres },
  };
}

function dockerDatabaseUrl({ user, password, database, port }) {
  return `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@127.0.0.1:${port}/${encodeURIComponent(database)}`;
}

export function createConfig(options = {}) {
  const tenantId = requireId(options.tenant_id ?? "tenant_local", "invalid_tenant_id");
  const producerId = requireId(options.producer_id ?? "chatgpt-scheduled-task", "invalid_producer_id");
  const allowedStreams = requireStreams(options.allowed_stream_ids ?? ["monitoring.example"]);
  const producerSecret = options.producer_secret ?? generateSecret();
  if (typeof producerSecret !== "string" || producerSecret.length < 32 || /[\r\n]/u.test(producerSecret)) {
    throw new OperatorError("invalid_producer_secret");
  }
  if (options.database_url !== undefined) {
    return validateConfig({
      format_version: CONFIG_FORMAT_VERSION,
      database_url: options.database_url,
      tenant_id: tenantId,
      producer_id: producerId,
      allowed_stream_ids: allowedStreams,
      producer_secret: producerSecret,
      postgres: { mode: "external" },
    });
  }
  const port = Number(options.postgres_port ?? 55432);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new OperatorError("invalid_postgres_port");
  const user = requireId(options.postgres_user ?? "agent_feed", "invalid_postgres_user");
  const database = requireId(options.postgres_database ?? "agent_feed", "invalid_postgres_database");
  const password = options.postgres_password ?? generateSecret();
  if (typeof password !== "string" || password.length < 32 || !SAFE_ENV_PATTERN.test(password)) {
    throw new OperatorError("invalid_postgres_password");
  }
  return validateConfig({
    format_version: CONFIG_FORMAT_VERSION,
    database_url: dockerDatabaseUrl({ user, password, database, port }),
    tenant_id: tenantId,
    producer_id: producerId,
    allowed_stream_ids: allowedStreams,
    producer_secret: producerSecret,
    postgres: { mode: "docker", user, database, port, password },
  });
}

export function renderPostgresEnv(config) {
  const checked = validateConfig(config);
  if (checked.postgres.mode !== "docker") throw new OperatorError("docker_postgres_not_configured");
  const values = {
    POSTGRES_USER: checked.postgres.user,
    POSTGRES_PASSWORD: checked.postgres.password,
    POSTGRES_DB: checked.postgres.database,
    AGENT_FEED_POSTGRES_PORT: String(checked.postgres.port),
  };
  for (const value of Object.values(values)) {
    if (typeof value !== "string" || !SAFE_ENV_PATTERN.test(value)) throw new OperatorError("unsafe_postgres_env_value");
  }
  return `${Object.entries(values).map(([key, value]) => `${key}=${value}`).join("\n")}\n`;
}

export function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

export function renderMcpWrapper({ cli_path, config_path }) {
  if (!path.isAbsolute(cli_path) || !path.isAbsolute(config_path)) throw new OperatorError("wrapper_paths_must_be_absolute");
  return `#!/bin/sh\nset -eu\nexec ${shellQuote(cli_path)} mcp --config ${shellQuote(config_path)}\n`;
}
