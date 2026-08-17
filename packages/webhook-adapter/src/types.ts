export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

export interface DnsResolver {
  resolve(hostname: string): Promise<readonly ResolvedAddress[]>;
}

import type { DeliveryEndpoint } from "@agent-feed/delivery-core";

export interface EndpointResolver<Endpoint = DeliveryEndpoint> {
  resolve(endpoint: Endpoint): string | Promise<string>;
}

export interface HttpRequest {
  method: "POST";
  url: string;
  headers: Readonly<Record<string, string>>;
  body: string;
  signal: AbortSignal;
  /** The adapter asks every client not to follow redirects. */
  redirect: "error" | "manual";
  /** Validated addresses prevent a client resolver from being rebound. */
  resolvedAddresses: readonly ResolvedAddress[];
  maxResponseBytes: number;
}

export interface HttpResponse {
  status: number;
  headers?: Readonly<Record<string, string>>;
  body?: Uint8Array;
  redirected?: boolean;
}

export interface HttpClient {
  request(input: HttpRequest): Promise<HttpResponse>;
}

export interface EndpointPolicyOptions {
  /** Exact lower-case host allowlist; empty means any public DNS host. */
  allowedHosts?: readonly string[];
  /** Production default is HTTPS only. This is intended for local tests. */
  allowHttpForTesting?: boolean;
  /** Production default is only the scheme's default port. */
  allowedPorts?: readonly number[];
  /** IP literals are rejected by default to preserve TLS hostname validation. */
  allowIpLiterals?: boolean;
  /** Query strings can contain credentials and are rejected by default. */
  allowQueryString?: boolean;
}

export interface ValidatedEndpoint {
  url: URL;
  addresses: readonly ResolvedAddress[];
}

export interface WebhookTransportOptions {
  dnsResolver?: DnsResolver;
  endpointResolver?: EndpointResolver;
  httpClient?: HttpClient;
  endpointPolicy?: EndpointPolicyOptions;
  timeoutMs?: number;
  maxRequestBytes?: number;
  maxResponseBytes?: number;
}

export type WebhookFailureCode =
  | "endpoint_resolution_failed"
  | "endpoint_invalid"
  | "endpoint_scheme_not_allowed"
  | "endpoint_port_not_allowed"
  | "endpoint_host_not_allowed"
  | "endpoint_credentials_not_allowed"
  | "endpoint_query_not_allowed"
  | "endpoint_ip_literal_not_allowed"
  | "dns_resolution_failed"
  | "dns_no_addresses"
  | "private_address_rejected"
  | "request_body_too_large"
  | "response_body_too_large"
  | "request_timeout"
  | "redirect_denied"
  | "network_error"
  | "http_error";

const WEBHOOK_FAILURE_MESSAGES: Readonly<Record<WebhookFailureCode, string>> = {
  endpoint_resolution_failed: "webhook endpoint resolution failed",
  endpoint_invalid: "webhook endpoint is invalid",
  endpoint_scheme_not_allowed: "webhook endpoint scheme is not allowed",
  endpoint_port_not_allowed: "webhook endpoint port is not allowed",
  endpoint_host_not_allowed: "webhook endpoint host is not allowed",
  endpoint_credentials_not_allowed: "webhook endpoint credentials are not allowed",
  endpoint_query_not_allowed: "webhook endpoint query strings are not allowed",
  endpoint_ip_literal_not_allowed: "webhook endpoint IP literals are not allowed",
  dns_resolution_failed: "webhook endpoint DNS resolution failed",
  dns_no_addresses: "webhook endpoint DNS returned no addresses",
  private_address_rejected: "webhook endpoint resolved to a non-public address",
  request_body_too_large: "webhook request exceeded the body limit",
  response_body_too_large: "webhook response exceeded the body limit",
  request_timeout: "webhook request timed out",
  redirect_denied: "webhook redirects are not followed",
  network_error: "webhook network request failed",
  http_error: "webhook HTTP request failed",
};

const WEBHOOK_FAILURE_CODES: ReadonlySet<string> = new Set(Object.keys(WEBHOOK_FAILURE_MESSAGES));

export interface WebhookFailure {
  code: WebhookFailureCode;
  /** Safe, stable text. It must not contain URLs, secrets, or response bodies. */
  message: string;
  retryable: boolean;
  status: number | null;
  retryAfterSeconds: number | null;
  responseBodyHash?: string;
}

/**
 * Recognize a transport failure across package copies and VM realms. The
 * message is deliberately not part of the trust decision; callers must use
 * the canonical message for the validated code rather than propagating an
 * arbitrary exception string.
 */
export function isWebhookFailureLike(value: unknown): value is WebhookFailure {
  if (value === null || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.code !== "string" || !WEBHOOK_FAILURE_CODES.has(candidate.code)) return false;
  if (typeof candidate.retryable !== "boolean") return false;
  if (candidate.status !== null && (typeof candidate.status !== "number" || !Number.isSafeInteger(candidate.status))) return false;
  if (candidate.retryAfterSeconds !== null
    && (typeof candidate.retryAfterSeconds !== "number" || !Number.isFinite(candidate.retryAfterSeconds) || candidate.retryAfterSeconds < 0)) {
    return false;
  }
  if (candidate.responseBodyHash !== undefined
    && (typeof candidate.responseBodyHash !== "string" || !/^[0-9a-f]{64}$/u.test(candidate.responseBodyHash))) {
    return false;
  }
  return true;
}

export function webhookFailureMessage(code: WebhookFailureCode): string {
  return WEBHOOK_FAILURE_MESSAGES[code];
}

export class WebhookTransportError extends Error {
  readonly code: WebhookFailureCode;
  readonly retryable: boolean;
  readonly status: number | null;
  readonly retryAfterSeconds: number | null;
  readonly responseBodyHash: string | undefined;

  constructor(failure: WebhookFailure) {
    super(webhookFailureMessage(failure.code));
    this.name = "WebhookTransportError";
    this.code = failure.code;
    this.retryable = failure.retryable;
    this.status = failure.status;
    this.retryAfterSeconds = failure.retryAfterSeconds;
    this.responseBodyHash = failure.responseBodyHash;
  }
}

export interface WebhookRetryDecision {
  kind: "retry" | "permanent";
  code: string;
  message: string;
  status: number | null;
  retryAfterSeconds: number | null;
  responseBodyHash?: string;
}
