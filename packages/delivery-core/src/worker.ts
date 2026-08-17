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

function requestHeaders(signed: SignedDelivery): Readonly<Record<string, string>> {
  return {
    "content-type": "application/json",
    "x-agent-feed-event-id": signed.eventId,
    "x-agent-feed-signature": signed.signature,
    "x-agent-feed-timestamp": String(signed.timestampSeconds),
    "x-agent-feed-attempt": String(signed.attempt),
    "x-agent-feed-trace-id": signed.traceId,
    ...(signed.keyId === undefined ? {} : { "x-agent-feed-key-id": signed.keyId }),
  };
}

function signerError(error: unknown): DeliveryError {
  const message = error instanceof Error ? error.message : String(error);
  return {
    code: "signing_error",
    message: message || "delivery signing failed",
    retryable: false,
    status: null,
  };
}

function safeLabels(claim: { event: { eventType: string }; job: { consumerId: string } }): Readonly<Record<string, string>> {
  return { event_type: claim.event.eventType, consumer: claim.job.consumerId };
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
    for (const claim of claims) items.push(await this.#deliver(claim.event.eventId, claim, now));
    return { claimed: claims.length, items };
  }

  async recoverExpiredLeases(limit = this.#batchSize): Promise<number> {
    const recovered = await this.#repository.recoverExpiredLeases({ now: iso(this.#clock.now()), limit });
    if (recovered > 0) this.#metrics.increment("delivery_lease_recovered", recovered);
    return recovered;
  }

  async #deliver(eventId: string, claim: DeliveryClaim, now: Date): Promise<WorkerItemResult> {
    const { job, event, subscription } = claim;
    const labels = safeLabels(claim);
    const base = { deliveryId: job.deliveryId, eventId, attempt: job.attempt };
    const leaseToken = job.leaseToken;
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
      const result = await this.#repository.deadLetter({
        deliveryId: job.deliveryId,
        leaseToken,
        attempt: job.attempt,
        replayGeneration: job.replayGeneration,
        now: iso(now),
        error,
      });
      return this.#transitionResult(base, "dead_lettered", result.applied, error, labels);
    }
    let signed: SignedDelivery;
    try {
      signed = this.#signer.sign({
        event,
        subscription,
        attempt: job.attempt,
        replayGeneration: job.replayGeneration,
        timestampSeconds: seconds(now),
      });
      if (
        signed.eventId !== event.eventId
        || signed.traceId !== event.traceId
        || signed.attempt !== job.attempt
        || signed.replayGeneration !== job.replayGeneration
      ) {
        throw new Error("signed_delivery_identity_mismatch");
      }
    } catch (error) {
      const deliveryError = signerError(error);
      const result = await this.#repository.deadLetter({
        deliveryId: job.deliveryId,
        leaseToken,
        attempt: job.attempt,
        replayGeneration: job.replayGeneration,
        now: iso(now),
        error: deliveryError,
      });
      return this.#transitionResult(base, "dead_lettered", result.applied, deliveryError, labels);
    }

    const request: DeliveryTransportRequest = {
      endpoint: subscription.endpoint,
      eventId,
      traceId: event.traceId,
      attempt: job.attempt,
      replayGeneration: job.replayGeneration,
      body: signed.body,
      signed,
      headers: requestHeaders(signed),
    };
    this.#metrics.increment("delivery_transport_attempt", 1, labels);

    let response: Awaited<ReturnType<DeliveryTransport["send"]>> | unknown;
    const transportStartedAt = now.getTime();
    try {
      response = await this.#transport.send(request);
    } catch (error) {
      response = error;
    }
    const transportFinishedAt = this.#clock.now().getTime();
    if (Number.isFinite(transportFinishedAt) && transportFinishedAt >= transportStartedAt) {
      this.#metrics.observe("delivery_latency_seconds", (transportFinishedAt - transportStartedAt) / 1000, labels);
    }
    const decision = this.#retryPolicy.classify(response, now);
    if (decision.kind === "success") {
      const ackInput: AcknowledgeInput = {
        deliveryId: job.deliveryId,
        leaseToken,
        attempt: job.attempt,
        replayGeneration: job.replayGeneration,
        now: iso(now),
        status: decision.status,
        ...(typeof response === "object" && response !== null && "responseBodyHash" in response && typeof (response as { responseBodyHash?: unknown }).responseBodyHash === "string"
          ? { responseBodyHash: (response as { responseBodyHash: string }).responseBodyHash }
          : {}),
      };
      const result = await this.#repository.acknowledge(ackInput);
      return this.#transitionResult(base, "acknowledged", result.applied, undefined, labels);
    }

    const deliveryError = deliveryErrorFromDecision(decision);
    if (decision.kind === "retry" && job.attempt < this.#retryPolicy.maxAttempts) {
      const delay = this.#retryPolicy.delaySeconds(
        job.attempt,
        { eventId, deliveryId: job.deliveryId, attempt: job.attempt, replayGeneration: job.replayGeneration },
        decision.retryAfterSeconds,
      );
      const next = new Date(now.getTime() + delay * 1000);
      const result = await this.#repository.scheduleRetry({
        deliveryId: job.deliveryId,
        leaseToken,
        attempt: job.attempt,
        replayGeneration: job.replayGeneration,
        now: iso(now),
        nextAttemptAt: iso(next),
        error: deliveryError,
      });
      return this.#transitionResult(base, "retry_scheduled", result.applied, deliveryError, labels);
    }

    const exhausted: DeliveryError = decision.kind === "retry"
      ? { ...deliveryError, code: "max_attempts_exceeded", message: "maximum delivery attempts exceeded", retryable: false }
      : deliveryError;
    const result = await this.#repository.deadLetter({
      deliveryId: job.deliveryId,
      leaseToken,
      attempt: job.attempt,
      replayGeneration: job.replayGeneration,
      now: iso(now),
      error: exhausted,
    });
    return this.#transitionResult(base, "dead_lettered", result.applied, exhausted, labels);
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
