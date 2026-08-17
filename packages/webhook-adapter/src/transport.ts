import { sha256Hex } from "@agent-feed/protocol-runtime";
import type {
  DeliveryEndpoint,
  DeliveryTransport,
  DeliveryTransportRequest,
  DeliveryTransportResponse,
} from "@agent-feed/delivery-core";
import { NodeHttpClient } from "./http-client.ts";
import { NodeDnsResolver, resolveSafeEndpoint } from "./ssrf.ts";
import {
  WebhookTransportError,
  type EndpointResolver,
  type HttpClient,
  type HttpResponse,
  type WebhookTransportOptions,
} from "./types.ts";

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_REQUEST_BYTES = 1024 * 1024;
const DEFAULT_MAX_RESPONSE_BYTES = 64 * 1024;

function headerRecord(headers: Readonly<Record<string, string>>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value.length > 8192 || /[\r\n]/u.test(value)) {
      throw new WebhookTransportError({
        code: "endpoint_invalid",
        message: "delivery header is invalid",
        retryable: false,
        status: null,
        retryAfterSeconds: null,
      });
    }
    result[key] = value;
  }
  return result;
}

function responseBodyHash(response: HttpResponse): string | undefined {
  return response.body === undefined ? undefined : sha256Hex(response.body);
}

function timeoutError(): WebhookTransportError {
  return new WebhookTransportError({
    code: "request_timeout",
    message: "webhook request timed out",
    retryable: true,
    status: null,
    retryAfterSeconds: null,
  });
}

function safeError(error: unknown): WebhookTransportError {
  if (error instanceof WebhookTransportError) return error;
  if (error instanceof Error && error.message === "response_body_too_large") {
    return new WebhookTransportError({
      code: "response_body_too_large",
      message: "webhook response exceeded the body limit",
      retryable: false,
      status: null,
      retryAfterSeconds: null,
    });
  }
  if (error instanceof Error && error.name === "AbortError") return timeoutError();
  return new WebhookTransportError({
    code: "network_error",
    message: "webhook network request failed",
    retryable: true,
    status: null,
    retryAfterSeconds: null,
  });
}

function runtimeSignedHeaders(request: DeliveryTransportRequest): Readonly<Record<string, string>> {
  const signed = request.signed as unknown as {
    headers?: Readonly<Record<string, string>>;
    deliveryId?: string;
    protocolVersion?: string;
  };
  return {
    ...(signed.headers ?? {}),
    ...(signed.deliveryId === undefined ? {} : { "x-agent-feed-delivery-id": signed.deliveryId }),
    ...(signed.protocolVersion === undefined ? {} : { "x-agent-feed-protocol-version": signed.protocolVersion }),
  };
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, signal: AbortController): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.abort();
      reject(timeoutError());
    }, timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export class IdentityEndpointResolver implements EndpointResolver {
  resolve(endpoint: DeliveryEndpoint): string {
    return endpoint.endpointRef;
  }
}

/**
 * Fetches a signed webhook without following redirects. DNS is resolved and
 * checked before every request, and the HTTP client receives those fixed
 * addresses so DNS rebinding cannot silently move the connection.
 */
export class WebhookTransport implements DeliveryTransport {
  readonly #dnsResolver;
  readonly #endpointResolver: EndpointResolver;
  readonly #httpClient: HttpClient;
  readonly #endpointPolicy;
  readonly #timeoutMs: number;
  readonly #maxRequestBytes: number;
  readonly #maxResponseBytes: number;

  constructor(options: WebhookTransportOptions = {}) {
    this.#dnsResolver = options.dnsResolver ?? new NodeDnsResolver();
    this.#endpointResolver = options.endpointResolver ?? new IdentityEndpointResolver();
    this.#httpClient = options.httpClient ?? new NodeHttpClient();
    this.#endpointPolicy = options.endpointPolicy ?? {};
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#maxRequestBytes = options.maxRequestBytes ?? DEFAULT_MAX_REQUEST_BYTES;
    this.#maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
    if (!Number.isSafeInteger(this.#timeoutMs) || this.#timeoutMs < 1) throw new Error("invalid_webhook_timeout");
    if (!Number.isSafeInteger(this.#maxRequestBytes) || this.#maxRequestBytes < 1) throw new Error("invalid_webhook_request_limit");
    if (!Number.isSafeInteger(this.#maxResponseBytes) || this.#maxResponseBytes < 1) throw new Error("invalid_webhook_response_limit");
  }

  async send(request: DeliveryTransportRequest): Promise<DeliveryTransportResponse> {
    const requestBytes = Buffer.byteLength(request.body, "utf8");
    if (requestBytes > this.#maxRequestBytes) {
      throw new WebhookTransportError({
        code: "request_body_too_large",
        message: "webhook request exceeded the body limit",
        retryable: false,
        status: null,
        retryAfterSeconds: null,
      });
    }
    const controller = new AbortController();
    let rawUrl: string;
    try {
      rawUrl = await withTimeout(Promise.resolve(this.#endpointResolver.resolve(request.endpoint)), this.#timeoutMs, controller);
    } catch (error) {
      if (error instanceof WebhookTransportError && error.code === "request_timeout") throw error;
      throw new WebhookTransportError({
        code: "endpoint_resolution_failed",
        message: "webhook endpoint resolution failed",
        retryable: false,
        status: null,
        retryAfterSeconds: null,
      });
    }
    let validated;
    try {
      validated = await withTimeout(
        resolveSafeEndpoint(rawUrl, this.#dnsResolver, this.#endpointPolicy),
        this.#timeoutMs,
        controller,
      );
    } catch (error) {
      throw safeError(error);
    }
    const headers = {
      ...headerRecord(request.headers),
      ...headerRecord(runtimeSignedHeaders(request)),
      "content-length": String(requestBytes),
    };
    let response: HttpResponse;
    try {
      response = await withTimeout(this.#httpClient.request({
        method: "POST",
        url: validated.url.toString(),
        headers,
        body: request.body,
        signal: controller.signal,
        redirect: "error",
        resolvedAddresses: validated.addresses,
        maxResponseBytes: this.#maxResponseBytes,
      }), this.#timeoutMs, controller);
    } catch (error) {
      throw safeError(error);
    }
    if (response.body !== undefined && response.body.byteLength > this.#maxResponseBytes) {
      throw new WebhookTransportError({
        code: "response_body_too_large",
        message: "webhook response exceeded the body limit",
        retryable: false,
        status: null,
        retryAfterSeconds: null,
      });
    }
    const bodyHash = responseBodyHash(response);
    if (response.redirected || (response.status >= 300 && response.status < 400)) {
      throw new WebhookTransportError({
        code: "redirect_denied",
        message: "webhook redirects are not followed",
        retryable: false,
        status: response.status,
        retryAfterSeconds: null,
        ...(bodyHash === undefined ? {} : { responseBodyHash: bodyHash }),
      });
    }
    return {
      status: response.status,
      ...(response.headers === undefined ? {} : { headers: response.headers }),
      ...(bodyHash === undefined ? {} : { responseBodyHash: bodyHash }),
    };
  }
}
