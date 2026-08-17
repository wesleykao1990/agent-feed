import {
  ExponentialRetryPolicy,
  type DeliveryTransportResponse,
  type RetryContext,
  type RetryDecision,
  type RetryPolicy,
} from "@agent-feed/delivery-core";
import {
  classifyWebhookResult,
  isWebhookFailureLike,
  WebhookTransportError,
} from "@agent-feed/webhook-adapter";

export interface WebhookRetryPolicyOptions {
  maxAttempts?: number;
  baseDelaySeconds?: number;
  maxDelaySeconds?: number;
  maxRetryAfterSeconds?: number;
}

function hasHttpStatus(value: unknown): value is DeliveryTransportResponse {
  if (value === null || typeof value !== "object" || !("status" in value)) return false;
  const status = (value as { status?: unknown }).status;
  return typeof status === "number" && Number.isSafeInteger(status);
}

function safeNetworkDecision(): RetryDecision {
  return {
    kind: "retry",
    code: "network_error",
    message: "webhook network request failed",
    status: null,
    retryAfterSeconds: null,
  };
}

/** Bridges typed adapter failures into the core state-machine decision type. */
export class WebhookRetryPolicy implements RetryPolicy {
  readonly #delegate: ExponentialRetryPolicy;
  readonly maxAttempts: number;

  constructor(options: WebhookRetryPolicyOptions = {}) {
    this.#delegate = new ExponentialRetryPolicy(options);
    this.maxAttempts = this.#delegate.maxAttempts;
  }

  classify(result: DeliveryTransportResponse | unknown, now: Date): RetryDecision {
    // Keep the instanceof branch for the normal in-process path, while the
    // stable shape handles duplicate package copies and cross-realm errors.
    if (result instanceof WebhookTransportError || isWebhookFailureLike(result) || hasHttpStatus(result)) {
      const decision = classifyWebhookResult(result, now);
      if (decision.kind === "success") return decision;
      if (decision.kind === "retry") {
        return {
          kind: "retry",
          code: decision.code,
          message: decision.message,
          status: decision.status,
          retryAfterSeconds: decision.retryAfterSeconds,
          ...(decision.responseBodyHash === undefined ? {} : { responseBodyHash: decision.responseBodyHash }),
        };
      }
      return {
        kind: "permanent",
        code: decision.code,
        message: decision.message,
        status: decision.status,
        ...(decision.responseBodyHash === undefined ? {} : { responseBodyHash: decision.responseBodyHash }),
      };
    }
    // Do not delegate arbitrary thrown errors to core: its generic fallback
    // preserves exception.message, which can contain a URL or secret-manager
    // diagnostic. All unknown transport failures are intentionally stable.
    return safeNetworkDecision();
  }

  delaySeconds(attempt: number, context: RetryContext, retryAfterSeconds?: number | null): number {
    return this.#delegate.delaySeconds(attempt, context, retryAfterSeconds);
  }
}
