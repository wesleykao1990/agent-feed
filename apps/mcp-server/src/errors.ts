import { ProducerServiceError, type ProducerServiceErrorCode } from "@agent-feed/producer-service";
import type { JsonRpcErrorResponse, JsonRpcId, McpToolCallResult } from "./types.ts";

const SAFE_SERVICE_ERROR_CODES = new Set<ProducerServiceErrorCode>([
  "unauthorized",
  "unauthorized_stream",
  "unauthorized_producer",
  "credential_expired",
  "rate_limited",
  "body_too_large",
  "unsupported_media_type",
  "invalid_json",
  "schema_validation_failed",
  "secret_field_rejected",
  "secret_bearing_evidence_rejected",
  "personal_data_rejected",
  "batch_limit_exceeded",
  "evidence_excerpt_too_large",
  "evidence_metadata_too_large",
  "invalid_input",
  "run_not_found",
  "batch_not_found",
  "run_id_conflict",
  "batch_id_conflict",
  "batch_sequence_not_increasing",
  "idempotency_payload_conflict",
  "duplicate_finding",
  "duplicate_evidence",
  "unresolved_evidence_ref",
  "completion_before_start",
  "invalid_scope_stats",
  "completion_counts_do_not_reconcile",
  "terminal_run_immutable",
  "storage_error",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const MAX_VALIDATION_ISSUES = 8;
const MAX_VALIDATION_PATH_LENGTH = 256;
const SAFE_VALIDATION_PATH = /^(?:\$|[A-Za-z0-9_$.[\]/~-]+)$/u;
const SENSITIVE_VALIDATION_PATH = /(?:^|[._/\[])(?:api[_-]?key|authorization|bearer|cookie|credential|password|secret|token)(?:$|[._/\]])/iu;

interface SafeValidationIssue {
  readonly path: string;
  readonly code: string;
}

function validationIssueCode(message: string): string {
  if (/required/iu.test(message)) return "required";
  if (/not allowed|additional propert/iu.test(message)) return "unexpected_field";
  if (/date-time|ISO date-time/iu.test(message)) return "invalid_date_time";
  if (/URI/iu.test(message)) return "invalid_uri";
  if (/sha256|digest/iu.test(message)) return "invalid_hash";
  if (/duplicate/iu.test(message)) return "duplicate_items";
  if (/too long|at most|more than/iu.test(message)) return "too_large";
  if (/at least|fewer than/iu.test(message)) return "too_small";
  if (/between|minimum|maximum|greater than|less than/iu.test(message)) return "out_of_range";
  if (/not supported/iu.test(message)) return "unsupported_value";
  if (/must be (?:an? )?(?:array|boolean|integer|null|number|object|string)/iu.test(message)) return "invalid_type";
  if (/format|pattern/iu.test(message)) return "invalid_format";
  return "invalid_value";
}

function safeValidationPath(value: unknown): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > MAX_VALIDATION_PATH_LENGTH
    || !SAFE_VALIDATION_PATH.test(value)
    || SENSITIVE_VALIDATION_PATH.test(value)
  ) return "$";
  return value;
}

function safeValidationIssues(error: ProducerServiceError): readonly SafeValidationIssue[] {
  if (error.code !== "schema_validation_failed") return [];
  const raw = error.details.errors;
  if (!Array.isArray(raw)) return [];
  const output: SafeValidationIssue[] = [];
  for (const item of raw) {
    if (!isRecord(item) || typeof item.message !== "string") continue;
    output.push({
      path: safeValidationPath(item.path),
      code: validationIssueCode(item.message),
    });
    if (output.length === MAX_VALIDATION_ISSUES) break;
  }
  return output;
}

export const JSON_RPC_ERROR_CODES = Object.freeze({
  parse_error: -32700,
  invalid_request: -32600,
  method_not_found: -32601,
  invalid_params: -32602,
  internal_error: -32603,
  server_not_initialized: -32002,
  unsupported_protocol_version: -32022,
});

export type JsonRpcErrorCode = (typeof JSON_RPC_ERROR_CODES)[keyof typeof JSON_RPC_ERROR_CODES];

/** A protocol error whose message/data are intentionally stable and bounded. */
export class McpProtocolError extends Error {
  readonly code: JsonRpcErrorCode;
  readonly data: Record<string, unknown> | undefined;

  constructor(code: JsonRpcErrorCode, message: string, data?: Record<string, unknown>) {
    super(message);
    this.name = "McpProtocolError";
    this.code = code;
    this.data = data;
  }
}

export function jsonRpcError(id: JsonRpcId | null, error: McpProtocolError): JsonRpcErrorResponse {
  const body = {
    code: error.code,
    message: error.message,
    ...(error.data === undefined ? {} : { data: error.data }),
  } satisfies JsonRpcErrorResponse["error"];
  return { jsonrpc: "2.0", id, error: body };
}

/**
 * Convert application failures to a bounded MCP tool result. In particular,
 * never include ProducerServiceError.message/details or arbitrary adapter
 * errors: those may contain SQL, credentials, source content, or identifiers.
 */
export function safeToolError(error: unknown): McpToolCallResult {
  const candidate = isRecord(error) && typeof error.code === "string" ? error.code : undefined;
  const code = error instanceof ProducerServiceError
    ? error.code
    : candidate !== undefined && SAFE_SERVICE_ERROR_CODES.has(candidate as ProducerServiceErrorCode)
      ? candidate
      : "internal_error";
  const issues = error instanceof ProducerServiceError ? safeValidationIssues(error) : [];
  const body = {
    error: code,
    ...(issues.length === 0 ? {} : { issues }),
  };
  return {
    content: [{ type: "text", text: JSON.stringify(body) }],
    isError: true,
    structuredContent: body,
  };
}

export function serviceErrorCode(error: unknown): ProducerServiceErrorCode | "internal_error" {
  return error instanceof ProducerServiceError ? error.code : "internal_error";
}

export function invalidParams(message = "Invalid params", data?: Record<string, unknown>): McpProtocolError {
  return new McpProtocolError(JSON_RPC_ERROR_CODES.invalid_params, message, data);
}

export function invalidRequest(message = "Invalid Request"): McpProtocolError {
  return new McpProtocolError(JSON_RPC_ERROR_CODES.invalid_request, message);
}

export function methodNotFound(): McpProtocolError {
  return new McpProtocolError(JSON_RPC_ERROR_CODES.method_not_found, "Method not found");
}

export function parseError(): McpProtocolError {
  return new McpProtocolError(JSON_RPC_ERROR_CODES.parse_error, "Parse error");
}

export function internalError(): McpProtocolError {
  return new McpProtocolError(JSON_RPC_ERROR_CODES.internal_error, "Internal error");
}

export function serverNotInitialized(): McpProtocolError {
  return new McpProtocolError(JSON_RPC_ERROR_CODES.server_not_initialized, "Server not initialized");
}

/**
 * Modern MCP uses a typed protocol error when a request claims a revision the
 * server cannot serve. Keep the requested value bounded and deterministic;
 * never echo arbitrary request data in the error body.
 */
export function unsupportedProtocolVersion(
  requested: unknown,
  supported: readonly string[],
): McpProtocolError {
  const requestedVersion = typeof requested === "string" && requested.length <= 64
    ? requested
    : "unknown";
  return new McpProtocolError(
    JSON_RPC_ERROR_CODES.unsupported_protocol_version,
    "Unsupported protocol version",
    { supported: [...supported], requested: requestedVersion },
  );
}
