/** Stable, non-sensitive categories used by the SDK itself. */
export type AgentFeedErrorKind =
  | "api_error"
  | "invalid_response"
  | "transport_error"
  | "timeout"
  | "aborted";

export interface AgentFeedErrorDiagnostic {
  /** Logical operation name supplied by the client, never a URL or body. */
  readonly operation: string;
  readonly status: number | null;
  /** Stable API error code, when the server supplied one. */
  readonly api_code: string | null;
  /** A server-provided correlation ID only when it is already redacted-safe. */
  readonly request_id: string | null;
  readonly retry_after_seconds: number | null;
}

export interface AgentFeedErrorOptions {
  operation: string;
  status?: number | null;
  retryable?: boolean;
  api_code?: string | null;
  request_id?: string | null;
  retry_after_seconds?: number | null;
}

/**
 * Base class for all errors that may cross the SDK boundary.
 *
 * The SDK intentionally does not retain the response body, URL, request
 * headers, or underlying transport exception. Those values can contain
 * credentials, cursors, evidence, or infrastructure details. `diagnostic`
 * contains only bounded, stable fields suitable for application logs.
 */
export class AgentFeedError extends Error {
  readonly kind: AgentFeedErrorKind;
  readonly retryable: boolean;
  readonly status: number | null;
  readonly operation: string;
  readonly api_code: string | null;
  readonly request_id: string | null;
  readonly retry_after_seconds: number | null;
  readonly diagnostic: AgentFeedErrorDiagnostic;

  constructor(kind: AgentFeedErrorKind, message: string, options: AgentFeedErrorOptions) {
    super(message);
    this.name = "AgentFeedError";
    this.kind = kind;
    this.retryable = options.retryable ?? false;
    this.status = options.status ?? null;
    this.operation = options.operation;
    this.api_code = options.api_code ?? null;
    this.request_id = options.request_id ?? null;
    this.retry_after_seconds = options.retry_after_seconds ?? null;
    this.diagnostic = Object.freeze({
      operation: this.operation,
      status: this.status,
      api_code: this.api_code,
      request_id: this.request_id,
      retry_after_seconds: this.retry_after_seconds,
    });
  }

  /** Safe serialization for structured logging. */
  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      kind: this.kind,
      message: this.message,
      retryable: this.retryable,
      diagnostic: this.diagnostic,
    };
  }
}

/** A server response with a stable, protocol-level error code. */
export class AgentFeedApiError extends AgentFeedError {
  readonly code: string;

  constructor(code: string, options: AgentFeedErrorOptions) {
    super("api_error", `agent_feed_api_error:${code}`, { ...options, api_code: code });
    this.name = "AgentFeedApiError";
    this.code = code;
  }
}

/** A non-HTTP transport failure whose source exception has been redacted. */
export class AgentFeedTransportError extends AgentFeedError {
  readonly code = "transport_error" as const;

  constructor(options: AgentFeedErrorOptions) {
    super("transport_error", "agent_feed_transport_error", options);
    this.name = "AgentFeedTransportError";
  }
}

/** A request exceeded its per-attempt timeout. */
export class AgentFeedTimeoutError extends AgentFeedError {
  readonly code = "timeout" as const;

  constructor(options: AgentFeedErrorOptions) {
    super("timeout", "agent_feed_request_timeout", { ...options, retryable: true });
    this.name = "AgentFeedTimeoutError";
  }
}

/** The caller's AbortSignal cancelled the request. This is never retried. */
export class AgentFeedAbortError extends AgentFeedError {
  readonly code = "aborted" as const;

  constructor(options: AgentFeedErrorOptions) {
    super("aborted", "agent_feed_request_aborted", { ...options, retryable: false });
    this.name = "AgentFeedAbortError";
  }
}

/** A successful HTTP response could not be decoded or has the wrong shape. */
export class AgentFeedResponseError extends AgentFeedError {
  readonly code = "invalid_response" as const;

  constructor(options: AgentFeedErrorOptions) {
    super("invalid_response", "agent_feed_invalid_response", { ...options, retryable: false });
    this.name = "AgentFeedResponseError";
  }
}

export function isAgentFeedError(value: unknown): value is AgentFeedError {
  return value instanceof AgentFeedError;
}
