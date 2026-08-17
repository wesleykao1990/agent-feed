import { deliveryErrorFromDecision, ExponentialRetryPolicy } from "./retry.ts";
import { NoopMetricsSink } from "./metrics.ts";
import type {
  AcknowledgeInput,
  Clock,
  DeliveryError,
  DeliveryRepository,
  DeliveryClaim,
  DeliverySigner,
  DeliveryTransport,
  DeliveryTransportRequest,
  LeaseClaimInput,
  MetricsSink,
  RetryPolicy,
  SignedDelivery,
  WorkerItemResult,
  WorkerOptions,
  WorkerRunResult,
} from "./types.ts";

function iso(date: Date): string {
  if (Number.isNaN(date.getTime())) throw new Error("clock_returned_invalid_date");
  return date.toISOString();
}

function seconds(date: Date): number {
  return Math.floor(date.getTime() / 1000);
}

const SAFE_ERROR_CODE = /^[a-z][a-z0-9_.-]{0,63}$/u;

function stableErrorCode(value: unknown): string {
  if (typeof value === "string" && SAFE_ERROR_CODE.test(value)) return value;
  return "delivery_error";
}

function genericErrorMessage(code: string): string {
  switch (code) {
    case "claim_identity_mismatch":
      return "delivery claim identity mismatch";
    case "delivery_endpoint_missing":
      return "delivery endpoint missing";
    case "signing_error":
      return "delivery signing failed";
    case "network_error":
      return "webhook transport failed";
    case "consumer_rate_limited":
      return "webhook receiver rate limited delivery";
    case "max_attempts_exceeded":
      return "maximum delivery attempts exceeded";
    case "invalid_claim":
      return "delivery claim is invalid";
    default:
      return "delivery attempt failed";
  }
}

/**
 * Error details from signers/transports may contain URLs, credentials, or
 * provider internals. Persist only a stable code and generic message; hashes
 * and HTTP status are deliberately retained because they are non-secret
 * correlation fields.
 */
function redactDeliveryError(error: DeliveryError): DeliveryError {
  const code = stableErrorCode(error.code);
  return {
    code,
    message: genericErrorMessage(code),
    retryable: error.retryable === true,
    status: typeof error.status === "number" || error.status === null ? error.status : null,
    ...(typeof error.responseBodyHash === "string" ? { responseBodyHash: error.responseBodyHash } : {}),
  };
}

function signerError(_error: unknown): DeliveryError {
  return redactDeliveryError({
    code: "signing_error",
    message: "delivery signing failed",
    retryable: false,
    status: null,
  });
}

function claimIdentityError(): DeliveryError {
  return redactDeliveryError({
    code: "claim_identity_mismatch",
    message: "delivery claim identity mismatch",
    retryable: false,
    status: null,
  });
}

function safeLabels(claim: { event: { eventType: string } }): Readonly<Record<string, string>> {
  return { event_type: claim.event.eventType };
}

function headerName(value: unknown): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > 256
    || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u.test(value)
  ) {
    throw new Error("signed_delivery_header_invalid");
  }
  return value.toLowerCase();
}

function headerValue(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 4096 || /[\r\n]/u.test(value)) {
    throw new Error("signed_delivery_header_invalid");
  }
  return value;
}

// These names are controlled by the HTTP transport and must not be supplied
// by a signer as an endpoint/request override. The core stays HTTP-client
// agnostic; this small denylist protects every transport implementation.
const UNSAFE_TRANSPORT_HEADERS = new Set([
  "connection",
  "content-length",
  "host",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function requiredHeader(
  headers: Readonly<Record<string, string>>,
  name: string,
  expected: string,
): void {
  const value = headers[name];
  if (value !== expected) throw new Error("signed_delivery_header_mismatch");
}

function validateClaim(claim: DeliveryClaim): void {
  const { job, event, subscription } = claim;
  if (
    job.eventId !== event.eventId
    || job.tenantId !== event.tenantId
    || job.traceId !== event.traceId
    || job.tenantId !== subscription.tenantId
    || job.consumerId !== subscription.consumerId
    || job.subscriptionId !== subscription.subscriptionId
  ) {
    throw new Error("claim_identity_mismatch");
  }
}

/** Validate only transport metadata; protocol body validation belongs to runtime consumers. */
function validateSignedDelivery(
  signed: SignedDelivery,
  event: DeliveryClaim["event"],
  job: DeliveryClaim["job"],
): void {
  if (
    typeof signed !== "object"
    || signed === null
    || typeof signed.rawBody !== "string"
    || signed.rawBody.length === 0
    || typeof signed.signature !== "string"
    || signed.signature.length === 0
    || typeof signed.eventId !== "string"
    || typeof signed.deliveryId !== "string"
    || typeof signed.keyId !== "string"
    || !Number.isSafeInteger(signed.timestampSeconds)
    || signed.timestampSeconds < 0
    || !Number.isSafeInteger(signed.attempt)
    || signed.attempt < 1
    || !Number.isSafeInteger(signed.replayGeneration)
    || signed.replayGeneration < 0
    || (signed.traceId !== null && typeof signed.traceId !== "string")
  ) {
    throw new Error("signed_delivery_invalid");
  }
  if (
    signed.eventId !== event.eventId
    || signed.deliveryId !== job.deliveryId
    || signed.traceId !== event.traceId
    || signed.attempt !== job.attempt
    || signed.replayGeneration !== job.replayGeneration
  ) {
    throw new Error("signed_delivery_identity_mismatch");
  }

  // These fields are copied into required headers below. Reject control
  // characters and oversized values before they can reach an adapter or
  // HTTP client, even if a signer implementation returns malformed metadata.
  headerValue(signed.eventId);
  headerValue(signed.deliveryId);
  headerValue(signed.signature);
  headerValue(signed.keyId);
  if (signed.traceId !== null) headerValue(signed.traceId);

  const rawHeaders = signed.headers as unknown;
  if (!rawHeaders || typeof rawHeaders !== "object" || Array.isArray(rawHeaders)) {
    throw new Error("signed_delivery_headers_invalid");
  }
  const headers: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [rawName, rawValue] of Object.entries(rawHeaders)) {
    const name = headerName(rawName);
    if (UNSAFE_TRANSPORT_HEADERS.has(name)) throw new Error("signed_delivery_header_unsafe");
    if (Object.hasOwn(headers, name)) throw new Error("signed_delivery_header_duplicate");
    headers[name] = headerValue(rawValue);
  }

  requiredHeader(headers, "x-agent-feed-event-id", signed.eventId);
  requiredHeader(headers, "x-agent-feed-delivery-id", signed.deliveryId);
  requiredHeader(headers, "x-agent-feed-attempt", String(signed.attempt));
  requiredHeader(headers, "x-agent-feed-timestamp", String(signed.timestampSeconds));
  requiredHeader(headers, "x-agent-feed-key-id", signed.keyId);
  requiredHeader(headers, "x-agent-feed-signature", signed.signature);
  requiredHeader(headers, "x-agent-feed-protocol-version", event.protocolVersion);
  if (signed.traceId === null) {
    if (headers["x-agent-feed-trace-id"] !== undefined) throw new Error("signed_delivery_trace_mismatch");
  } else {
    requiredHeader(headers, "x-agent-feed-trace-id", signed.traceId);
  }
}

export class DeliveryWorker {
  readonly #repository: DeliveryRepository;
  readonly #transport: DeliveryTransport;
  readonly #signer: DeliverySigner;
  readonly #clock: Clock;
  readonly #metrics: MetricsSink;
  readonly #retryPolicy: RetryPolicy;
  readonly #workerId: string;
  readonly #tenantId: string | undefined;
  readonly #consumerId: string | undefined;
  readonly #batchSize: number;
  readonly #leaseDurationSeconds: number;

  constructor(options: WorkerOptions) {
    this.#repository = options.repository;
    this.#transport = options.transport;
    this.#signer = options.signer;
    this.#clock = options.clock;
    this.#metrics = options.metrics ?? new NoopMetricsSink();
    this.#retryPolicy = options.retryPolicy ?? new ExponentialRetryPolicy();
    this.#workerId = options.workerId;
    this.#tenantId = options.tenantId;
    this.#consumerId = options.consumerId;
    this.#batchSize = options.batchSize ?? 10;
    this.#leaseDurationSeconds = options.leaseDurationSeconds ?? 60;
    if (!this.#workerId) throw new Error("worker_id_required");
    if (!Number.isSafeInteger(this.#batchSize) || this.#batchSize < 1) throw new Error("invalid_worker_batch_size");
    if (!Number.isFinite(this.#leaseDurationSeconds) || this.#leaseDurationSeconds <= 0) throw new Error("invalid_lease_duration");
  }

  async runOnce(): Promise<WorkerRunResult> {
    const now = this.#clock.now();
    const nowIso = iso(now);
    const claimInput: LeaseClaimInput = {
      now: nowIso,
      limit: this.#batchSize,
      leaseDurationSeconds: this.#leaseDurationSeconds,
      workerId: this.#workerId,
      ...(this.#tenantId === undefined ? {} : { tenantId: this.#tenantId }),
      ...(this.#consumerId === undefined ? {} : { consumerId: this.#consumerId }),
    };
    const claims = await this.#repository.claimDue(claimInput);
    this.#metrics.increment("delivery_claimed", claims.length);
    const items: WorkerItemResult[] = [];
    for (const claim of claims) items.push(await this.#deliver(claim));
    return { claimed: claims.length, items };
  }

  async recoverExpiredLeases(limit = this.#batchSize): Promise<number> {
    const recovered = await this.#repository.recoverExpiredLeases({ now: iso(this.#clock.now()), limit });
    if (recovered > 0) this.#metrics.increment("delivery_lease_recovered", recovered);
    return recovered;
  }

  async #deliver(claim: DeliveryClaim): Promise<WorkerItemResult> {
    // Claiming is batched, but signing and lease transitions are per item.
    // Refresh here so a slow earlier item cannot give this item a stale
    // timestamp or dead-letter/retry base.
    const now = this.#clock.now();
    const { job, event, subscription } = claim;
    const labels = safeLabels(claim);
    const base = { deliveryId: job.deliveryId, eventId: event.eventId, attempt: job.attempt };
    const leaseToken = job.leaseToken;
    try {
      validateClaim(claim);
    } catch {
      const error = claimIdentityError();
      if (!leaseToken) return { ...base, outcome: "failed", error };
      return this.#deadLetter(claim, now, error, labels, base);
    }
    if (!leaseToken) {
      const error: DeliveryError = {
        code: "invalid_claim",
        message: "delivery claim has no lease token",
        retryable: false,
        status: null,
      };
      return { ...base, outcome: "failed", error };
    }
    if (subscription.endpoint === null) {
      const error: DeliveryError = {
        code: "delivery_endpoint_missing",
        message: "webhook delivery requires an endpoint",
        retryable: false,
        status: null,
      };
      return this.#deadLetter(claim, now, error, labels, base);
    }
    let signed: SignedDelivery;
    try {
      signed = this.#signer.sign({
        event,
        subscription,
        deliveryId: job.deliveryId,
        attempt: job.attempt,
        replayGeneration: job.replayGeneration,
        timestampSeconds: seconds(now),
      });
      validateSignedDelivery(signed, event, job);
    } catch (error) {
      const deliveryError = signerError(error);
      return this.#deadLetter(claim, now, deliveryError, labels, base);
    }

    const request: DeliveryTransportRequest = {
      endpoint: subscription.endpoint,
      eventId: event.eventId,
      deliveryId: job.deliveryId,
      traceId: event.traceId,
      attempt: job.attempt,
      replayGeneration: job.replayGeneration,
      body: signed.rawBody,
      signed,
      headers: signed.headers,
    };
    this.#metrics.increment("delivery_transport_attempt", 1, labels);

    let response: Awaited<ReturnType<DeliveryTransport["send"]>> | unknown;
    const transportStartedAt = now.getTime();
    try {
      response = await this.#transport.send(request);
    } catch (error) {
      response = error;
    }
    const outcomeNow = this.#clock.now();
    const outcomeIso = iso(outcomeNow);
    const transportFinishedAt = outcomeNow.getTime();
    if (Number.isFinite(transportFinishedAt) && transportFinishedAt >= transportStartedAt) {
      this.#metrics.observe("delivery_latency_seconds", (transportFinishedAt - transportStartedAt) / 1000, labels);
    }
    const decision = this.#retryPolicy.classify(response, outcomeNow);
    if (decision.kind === "success") {
      const ackInput: AcknowledgeInput = {
        tenantId: job.tenantId,
        consumerId: job.consumerId,
        subscriptionId: job.subscriptionId,
        deliveryId: job.deliveryId,
        leaseToken,
        attempt: job.attempt,
        replayGeneration: job.replayGeneration,
        now: outcomeIso,
        status: decision.status,
        ...(typeof response === "object" && response !== null && "responseBodyHash" in response && typeof (response as { responseBodyHash?: unknown }).responseBodyHash === "string"
          ? { responseBodyHash: (response as { responseBodyHash: string }).responseBodyHash }
          : {}),
      };
      const result = await this.#repository.acknowledge(ackInput);
      return this.#transitionResult(base, "acknowledged", result.applied, undefined, labels);
    }

    const deliveryError = redactDeliveryError(deliveryErrorFromDecision(decision));
    if (decision.kind === "retry" && job.attempt < this.#retryPolicy.maxAttempts) {
      const delay = this.#retryPolicy.delaySeconds(
        job.attempt,
        { eventId: event.eventId, deliveryId: job.deliveryId, attempt: job.attempt, replayGeneration: job.replayGeneration },
        decision.retryAfterSeconds,
      );
      const next = new Date(outcomeNow.getTime() + delay * 1000);
      const result = await this.#repository.scheduleRetry({
        tenantId: job.tenantId,
        consumerId: job.consumerId,
        subscriptionId: job.subscriptionId,
        deliveryId: job.deliveryId,
        leaseToken,
        attempt: job.attempt,
        replayGeneration: job.replayGeneration,
        now: outcomeIso,
        nextAttemptAt: iso(next),
        error: deliveryError,
      });
      return this.#transitionResult(base, "retry_scheduled", result.applied, deliveryError, labels);
    }

    const exhausted: DeliveryError = decision.kind === "retry"
      ? { ...deliveryError, code: "max_attempts_exceeded", message: "maximum delivery attempts exceeded", retryable: false }
      : deliveryError;
    return this.#deadLetter(claim, outcomeNow, exhausted, labels, base);
  }

  async #deadLetter(
    claim: DeliveryClaim,
    now: Date,
    error: DeliveryError,
    labels: Readonly<Record<string, string>>,
    base: { deliveryId: string; eventId: string; attempt: number },
  ): Promise<WorkerItemResult> {
    const { job } = claim;
    const persistedError = redactDeliveryError(error);
    const result = await this.#repository.deadLetter({
      tenantId: job.tenantId,
      consumerId: job.consumerId,
      subscriptionId: job.subscriptionId,
      deliveryId: job.deliveryId,
      leaseToken: job.leaseToken ?? "",
      attempt: job.attempt,
      replayGeneration: job.replayGeneration,
      now: iso(now),
      error: persistedError,
    });
    return this.#transitionResult(base, "dead_lettered", result.applied, persistedError, labels);
  }

  #transitionResult(
    base: { deliveryId: string; eventId: string; attempt: number },
    expected: Exclude<WorkerItemResult["outcome"], "failed" | "stale_lease">,
    applied: boolean,
    error: DeliveryError | undefined,
    labels: Readonly<Record<string, string>>,
  ): WorkerItemResult {
    if (!applied) {
      this.#metrics.increment("delivery_stale_outcome", 1, labels);
      return { ...base, outcome: "stale_lease", ...(error === undefined ? {} : { error }) };
    }
    this.#metrics.increment(`delivery_${expected}`, 1, labels);
    return { ...base, outcome: expected, ...(error === undefined ? {} : { error }) };
  }
}
