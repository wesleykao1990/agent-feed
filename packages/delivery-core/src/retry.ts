import type {
  DeliveryTransportResponse,
  RetryContext,
  RetryDecision,
  RetryPolicy,
} from "./types.ts";

function headerValue(
  headers: Readonly<Record<string, string>> | undefined,
  name: string,
): string | null {
  if (!headers) return null;
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted) return value;
  }
  return null;
}

/** Parse Retry-After seconds or an HTTP-date without importing an HTTP stack. */
export function parseRetryAfter(
  headers: Readonly<Record<string, string>> | undefined,
  now: Date,
): number | null {
  const value = headerValue(headers, "retry-after");
  if (value === null || value.trim() === "") return null;
  const seconds = Number(value.trim());
  if (Number.isFinite(seconds) && seconds >= 0) return seconds;
  const date = Date.parse(value);
  if (Number.isNaN(date)) return null;
  return Math.max(0, (date - now.getTime()) / 1000);
}

function statusDecision(
  response: DeliveryTransportResponse,
  now: Date,
): RetryDecision {
  const { status, responseBodyHash } = response;
  if (status >= 200 && status <= 299) return { kind: "success", status };
  if (status === 408 || status === 425 || status === 429 || (status >= 500 && status <= 599)) {
    return {
      kind: "retry",
      code: status === 429 ? "consumer_rate_limited" : `http_${status}`,
      status,
      retryAfterSeconds: parseRetryAfter(response.headers, now),
      ...(responseBodyHash === undefined ? {} : { responseBodyHash }),
    };
  }
  return {
    kind: "permanent",
    code: status >= 400 && status <= 499 ? `http_${status}` : `unexpected_http_${status}`,
    status,
    ...(responseBodyHash === undefined ? {} : { responseBodyHash }),
  };
}

function networkDecision(error: unknown): RetryDecision {
  const message = error instanceof Error ? error.message : String(error);
  return {
    kind: "retry",
    code: "network_error",
    ...(message ? { message } : {}),
    status: null,
    retryAfterSeconds: null,
  };
}

export interface ExponentialRetryPolicyOptions {
  maxAttempts?: number;
  baseDelaySeconds?: number;
  maxDelaySeconds?: number;
  maxRetryAfterSeconds?: number;
}

/**
 * Pure capped exponential policy. Jitter is intentionally absent from the
 * default so the next schedule is deterministic and reproducible. Deployments
 * may wrap this policy with a deterministic, event-seeded jitter function.
 */
export class ExponentialRetryPolicy implements RetryPolicy {
  readonly maxAttempts: number;
  readonly #baseDelaySeconds: number;
  readonly #maxDelaySeconds: number;
  readonly #maxRetryAfterSeconds: number;

  constructor(options: ExponentialRetryPolicyOptions = {}) {
    this.maxAttempts = options.maxAttempts ?? 5;
    this.#baseDelaySeconds = options.baseDelaySeconds ?? 5;
    this.#maxDelaySeconds = options.maxDelaySeconds ?? 300;
    this.#maxRetryAfterSeconds = options.maxRetryAfterSeconds ?? this.#maxDelaySeconds;
    if (!Number.isSafeInteger(this.maxAttempts) || this.maxAttempts < 1) throw new Error("invalid_max_attempts");
    if (!Number.isFinite(this.#baseDelaySeconds) || this.#baseDelaySeconds <= 0) throw new Error("invalid_base_delay");
    if (!Number.isFinite(this.#maxDelaySeconds) || this.#maxDelaySeconds < this.#baseDelaySeconds) throw new Error("invalid_max_delay");
    if (!Number.isFinite(this.#maxRetryAfterSeconds) || this.#maxRetryAfterSeconds < 0) throw new Error("invalid_max_retry_after");
  }

  classify(result: DeliveryTransportResponse | unknown, now: Date): RetryDecision {
    if (result && typeof result === "object" && "status" in result) {
      const status = (result as { status: unknown }).status;
      if (typeof status === "number" && Number.isSafeInteger(status)) {
        return statusDecision(result as DeliveryTransportResponse, now);
      }
    }
    return networkDecision(result);
  }

  delaySeconds(
    attempt: number,
    _context: RetryContext,
    retryAfterSeconds: number | null = null,
  ): number {
    if (!Number.isSafeInteger(attempt) || attempt < 1) throw new Error("invalid_attempt");
    const exponential = Math.min(this.#maxDelaySeconds, this.#baseDelaySeconds * (2 ** (attempt - 1)));
    if (retryAfterSeconds === null || !Number.isFinite(retryAfterSeconds) || retryAfterSeconds < 0) return exponential;
    return Math.min(this.#maxRetryAfterSeconds, this.#maxDelaySeconds, retryAfterSeconds);
  }
}

export function deliveryErrorFromDecision(decision: Exclude<RetryDecision, { kind: "success" }>): {
  code: string;
  message: string;
  retryable: boolean;
  status: number | null;
  responseBodyHash?: string;
} {
  return {
    code: decision.code,
    message: decision.message ?? decision.code,
    retryable: decision.kind === "retry",
    status: decision.status,
    ...(decision.responseBodyHash === undefined ? {} : { responseBodyHash: decision.responseBodyHash }),
  };
}
