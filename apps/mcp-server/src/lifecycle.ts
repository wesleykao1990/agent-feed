import { ProducerServiceError, type ProducerPrincipal } from "@agent-feed/producer-service";
import {
  McpProtocolError,
  invalidParams,
  safeToolError,
} from "./errors.ts";
import { MCP_TOOL_NAMES, type McpToolName } from "./tools.ts";
import type {
  McpServerOptions,
  McpToolCallResult,
  ProducerServiceBoundary,
} from "./types.ts";

const DEFAULT_MAX_ARGUMENT_BYTES = 1024 * 1024;
const SECRET_CONTROL_KEYS = new Set([
  "authorization",
  "bearer",
  "access_token",
  "api_key",
  "apikey",
  "password",
  "secret",
  "token",
  "client_secret",
  "clientsecret",
  "credential",
  "credentials",
  "cookie",
  "private_key",
  "privatekey",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertPrincipal(value: ProducerPrincipal): ProducerPrincipal {
  if (!isRecord(value)
    || typeof value.tenant_id !== "string"
    || value.tenant_id.length === 0
    || typeof value.producer_id !== "string"
    || value.producer_id.length === 0
    || !Array.isArray(value.allowed_stream_ids)
    || value.allowed_stream_ids.length === 0
    || !value.allowed_stream_ids.every((item) => typeof item === "string" && item.length > 0 && item !== "*")) {
    throw new ProducerServiceError("unauthorized", "valid bearer credentials are required");
  }
  if (value.producer_id === "*") throw new ProducerServiceError("unauthorized", "valid bearer credentials are required");
  return structuredClone(value);
}

function serializedBytes(value: unknown): number {
  try {
    const serialized = JSON.stringify(value);
    return Buffer.byteLength(serialized ?? "", "utf8");
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function safeResult(value: unknown): { text: string; structured?: unknown; failed?: boolean } {
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) return { text: "null" };
    // Parse the serialized form back so the response cannot retain a cyclic
    // object, BigInt, function, or custom `toJSON` value from an adapter fake.
    return { text: serialized, structured: JSON.parse(serialized) as unknown };
  } catch {
    return { text: JSON.stringify({ error: "internal_error" }), failed: true };
  }
}

function toolName(value: string): value is McpToolName {
  return (MCP_TOOL_NAMES as readonly string[]).includes(value);
}

function containsSecretControlKey(value: unknown): boolean {
  if (Array.isArray(value)) return value.some((item) => containsSecretControlKey(item));
  if (!isRecord(value)) return false;
  for (const [key, child] of Object.entries(value)) {
    const normalized = key.toLowerCase().replace(/[^a-z0-9]/gu, "");
    if (!["containssecrets", "containspersonaldata", "securityflags"].includes(normalized)
      && (SECRET_CONTROL_KEYS.has(key.toLowerCase())
        || /(?:token|secret|password|passwd|apikey|privatekey|authorization|cookie|credential)$/u.test(normalized))) {
      return true;
    }
    if (containsSecretControlKey(child)) return true;
  }
  return false;
}

function toolArguments(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw invalidParams("Invalid params", { error: "invalid_tool_arguments" });
  // Authentication belongs to the composition root. Do not pass a caller's
  // attempted credential field to the producer service or echo it in errors.
  if (containsSecretControlKey(value)) {
    throw invalidParams("Invalid params", { error: "authentication_fields_are_not_tool_arguments" });
  }
  return value;
}

function requireRunId(value: Record<string, unknown>): string {
  if (typeof value.run_id !== "string" || value.run_id.length === 0) {
    throw invalidParams("Invalid params", { error: "run_id_required" });
  }
  return value.run_id;
}

/**
 * Tool-level adapter for the existing producer application service. It does
 * not validate or persist protocol records itself; the service remains the
 * sole lifecycle policy boundary.
 */
export class LifecycleToolRouter {
  readonly service: ProducerServiceBoundary;
  readonly #injectedPrincipal: ProducerPrincipal | undefined;
  readonly #authorization: string | undefined;
  readonly #maxArgumentBytes: number;

  constructor(options: McpServerOptions) {
    this.service = options.service;
    if (options.service === undefined || typeof options.service !== "object") {
      throw new Error("producer_service_required");
    }
    const injectedPrincipal = options.principal ?? options.auth_principal ?? options.authPrincipal;
    this.#injectedPrincipal = injectedPrincipal === undefined ? undefined : assertPrincipal(injectedPrincipal);
    this.#authorization = options.authorization;
    const configuredLimit = options.max_argument_bytes ?? options.service.security?.max_body_bytes ?? DEFAULT_MAX_ARGUMENT_BYTES;
    if (!Number.isSafeInteger(configuredLimit) || configuredLimit < 1) throw new Error("invalid_max_argument_bytes");
    this.#maxArgumentBytes = configuredLimit;
  }

  async call(name: string, rawArguments: unknown): Promise<McpToolCallResult> {
    if (!toolName(name)) throw invalidParams("Invalid params", { error: "unknown_tool" });
    const args = toolArguments(rawArguments);
    if (serializedBytes(args) > this.#maxArgumentBytes) {
      return safeToolError(new ProducerServiceError("body_too_large", "tool arguments exceed the configured limit"));
    }
    const runId = name === "begin_run" ? undefined : requireRunId(args);

    let principal: ProducerPrincipal;
    try {
      principal = this.#resolvePrincipal();
      this.service.assertRateAllowed?.(principal);
      const result = name === "begin_run"
        ? await this.service.beginRun(args, principal)
        : name === "submit_batch"
          ? await this.service.submitBatch(runId!, args, principal)
          : await this.service.completeRun(runId!, args, principal);
      const serialized = safeResult(result);
      const response: McpToolCallResult = {
        content: [{ type: "text", text: serialized.text }],
      };
      if (serialized.failed === true) response.isError = true;
      if (serialized.structured !== undefined) response.structuredContent = serialized.structured;
      return response;
    } catch (error) {
      if (error instanceof McpProtocolError) throw error;
      return safeToolError(error);
    }
  }

  #resolvePrincipal(): ProducerPrincipal {
    if (this.#injectedPrincipal !== undefined) return this.#injectedPrincipal;
    if (typeof this.#authorization !== "string" || this.#authorization.length === 0 || this.service.authenticate === undefined) {
      throw new ProducerServiceError("unauthorized", "valid bearer credentials are required");
    }
    let principal: ProducerPrincipal;
    try {
      principal = this.service.authenticate({ authorization: this.#authorization });
    } catch {
      throw new ProducerServiceError("unauthorized", "valid bearer credentials are required");
    }
    return assertPrincipal(principal);
  }
}

export function createLifecycleToolRouter(options: McpServerOptions): LifecycleToolRouter {
  return new LifecycleToolRouter(options);
}
