import type { DeliveryTransportResponse } from "@agent-feed/delivery-core";
import type { WebhookRetryDecision } from "./types.ts";
import { isWebhookFailureLike, webhookFailureMessage } from "./types.ts";

function retryAfter(headers: Readonly<Record<string, string>> | undefined, now: Date): number | null {
  if (!headers) return null;
  const value = Object.entries(headers).find(([key]) => key.toLowerCase() === "retry-after")?.[1];
  if (!value) return null;
  const seconds = Number(value.trim());
  if (Number.isFinite(seconds) && seconds >= 0) return seconds;
  const date = Date.parse(value);
  return Number.isNaN(date) ? null : Math.max(0, (date - now.getTime()) / 1000);
}

/** Explicit adapter-side classification for configuration/network failures. */
export function classifyWebhookResult(
  result: DeliveryTransportResponse | unknown,
  now: Date,
): WebhookRetryDecision | { kind: "success"; status: number } {
  // Use the stable failure shape as well as the class identity. This keeps
  // retry behavior intact when an error crosses a VM boundary or comes from a
  // duplicate installation of the adapter package.
  if (isWebhookFailureLike(result)) {
    return {
      kind: result.retryable ? "retry" : "permanent",
      code: result.code,
      message: webhookFailureMessage(result.code),
      status: result.status,
      retryAfterSeconds: result.retryAfterSeconds,
      ...(result.responseBodyHash === undefined ? {} : { responseBodyHash: result.responseBodyHash }),
    };
  }
  if (result && typeof result === "object" && "status" in result) {
    const response = result as DeliveryTransportResponse;
    if (response.status >= 200 && response.status <= 299) return { kind: "success", status: response.status };
    const retryable = response.status === 408 || response.status === 425 || response.status === 429 || (response.status >= 500 && response.status <= 599);
    return {
      kind: retryable ? "retry" : "permanent",
      code: retryable ? (response.status === 429 ? "consumer_rate_limited" : `http_${response.status}`) : `http_${response.status}`,
      message: retryable ? "consumer delivery is temporarily unavailable" : "consumer rejected webhook delivery",
      status: response.status,
      retryAfterSeconds: retryable ? retryAfter(response.headers, now) : null,
      ...(response.responseBodyHash === undefined ? {} : { responseBodyHash: response.responseBodyHash }),
    };
  }
  return {
    kind: "retry",
    code: "network_error",
    message: "webhook network request failed",
    status: null,
    retryAfterSeconds: null,
  };
}
