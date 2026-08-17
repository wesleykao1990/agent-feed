export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export type JsonObject = { [key: string]: JsonValue };

export type DeliveryState =
  | "queued"
  | "retry_wait"
  | "leased"
  | "acknowledged"
  | "dead_letter";

export type DeliveryEventType =
  | "run.started"
  | "finding.submitted"
  | "run.completed"
  | "run.partial"
  | "run.failed"
  | (string & {});

/**
 * Immutable source event. `attempt` is intentionally absent: retry attempt
 * metadata belongs to the delivery envelope, never to the source event.
 */
export interface DeliveryEvent {
  protocolVersion: "0.1";
  eventId: string;
  eventType: DeliveryEventType;
  tenantId: string;
  streamId: string;
  runId: string;
  findingId: string | null;
  occurredAt: string;
  sequence: string;
  traceId: string;
  payload: JsonObject;
  payloadHash: string;
  /** Denormalized selector fields; adapters may derive these from payload. */
  findingType?: string;
  routingTags?: readonly string[];
  /** A quarantined event is retained for audit but is not faned out. */
  deliveryEligible: boolean;
}

export interface ConsumerSubscription {
  tenantId: string;
  consumerId: string;
  subscriptionId: string;
  selectorVersion: string;
  streamIds: readonly string[];
  findingTypes: readonly string[];
  routingTags: readonly string[];
  includeRunEvents: boolean;
  active: boolean;
  endpoint: DeliveryEndpoint | null;
}

export interface DeliveryEndpoint {
  url: string;
  /** The signer resolves this reference; raw secrets never enter the domain. */
  secretRef: string;
  keyId?: string;
}

export interface DeliveryJob {
  deliveryId: string;
  tenantId: string;
  consumerId: string;
  subscriptionId: string;
  eventId: string;
  traceId: string;
  state: DeliveryState;
  /** Last claim/send attempt number. Starts at 0 before the first claim. */
  attempt: number;
  replayGeneration: number;
  nextAttemptAt: string;
  leaseToken: string | null;
  leaseExpiresAt: string | null;
  acknowledgedAt: string | null;
  deadLetteredAt: string | null;
  lastError: DeliveryError | null;
}

export interface DeliveryClaim {
  job: DeliveryJob;
  event: DeliveryEvent;
  subscription: ConsumerSubscription;
}

export interface SignedDelivery {
  eventId: string;
  body: string;
  signature: string;
  timestampSeconds: number;
  attempt: number;
  replayGeneration: number;
  traceId: string;
  keyId?: string;
}

export interface DeliveryTransportRequest {
  endpoint: DeliveryEndpoint;
  eventId: string;
  traceId: string;
  attempt: number;
  replayGeneration: number;
  body: string;
  signed: SignedDelivery;
  headers: Readonly<Record<string, string>>;
}

export interface DeliveryTransportResponse {
  status: number;
  headers?: Readonly<Record<string, string>>;
  responseBodyHash?: string;
}

export interface DeliveryError {
  code: string;
  message: string;
  retryable: boolean;
  status: number | null;
  responseBodyHash?: string;
}

export interface LeaseClaimInput {
  now: string;
  limit: number;
  leaseDurationSeconds: number;
  workerId: string;
  tenantId?: string;
  consumerId?: string;
}

export interface LeaseOutcomeInput {
  deliveryId: string;
  leaseToken: string;
  attempt: number;
  replayGeneration: number;
  now: string;
}

export type LeaseTransitionResult =
  | { applied: true; job: DeliveryJob }
  | { applied: false; reason: "stale_lease" | "already_terminal" | "not_found"; job: DeliveryJob | null };

export interface AcknowledgeInput extends LeaseOutcomeInput {
  status: number;
  responseBodyHash?: string;
}

export interface RetryInput extends LeaseOutcomeInput {
  nextAttemptAt: string;
  error: DeliveryError;
}

export interface DeadLetterInput extends LeaseOutcomeInput {
  error: DeliveryError;
}

export interface ReplayInput {
  tenantId: string;
  consumerId: string;
  deliveryId: string;
  requestedAt: string;
  reason: string;
}

export interface DeliveryRepository {
  /**
   * Called from the same transaction that accepts the producer record. The
   * adapter must make the outbox event durable before returning.
   */
  appendOutboxEvent(
    event: DeliveryEvent,
    subscriptions: readonly ConsumerSubscription[],
  ): Promise<void>;
  claimDue(input: LeaseClaimInput): Promise<readonly DeliveryClaim[]>;
  acknowledge(input: AcknowledgeInput): Promise<LeaseTransitionResult>;
  scheduleRetry(input: RetryInput): Promise<LeaseTransitionResult>;
  deadLetter(input: DeadLetterInput): Promise<LeaseTransitionResult>;
  recoverExpiredLeases(input: { now: string; limit: number }): Promise<number>;
  replay(input: ReplayInput): Promise<DeliveryJob>;
  pull(input: PullInput): Promise<PullPage>;
}

export interface DeliveryQueue {
  /** A queue message is only a wake-up hint; the repository is authoritative. */
  enqueue(deliveryId: string): Promise<void>;
}

export interface DeliverySigner {
  sign(input: {
    event: DeliveryEvent;
    subscription: ConsumerSubscription;
    attempt: number;
    replayGeneration: number;
    timestampSeconds: number;
  }): SignedDelivery;
}

export interface DeliveryTransport {
  send(request: DeliveryTransportRequest): Promise<DeliveryTransportResponse>;
}

export interface Clock {
  now(): Date;
}

export interface MetricsSink {
  increment(name: string, value?: number, labels?: Readonly<Record<string, string>>): void;
  observe(name: string, value: number, labels?: Readonly<Record<string, string>>): void;
}

export interface RetryContext {
  eventId: string;
  deliveryId: string;
  attempt: number;
  replayGeneration: number;
}

export type RetryDecision =
  | { kind: "success"; status: number }
  | {
    kind: "retry";
    code: string;
    message?: string;
    status: number | null;
    retryAfterSeconds: number | null;
    responseBodyHash?: string;
  }
  | {
    kind: "permanent";
    code: string;
    message?: string;
    status: number | null;
    responseBodyHash?: string;
  };

export interface RetryPolicy {
  readonly maxAttempts: number;
  classify(
    result: DeliveryTransportResponse | unknown,
    now: Date,
  ): RetryDecision;
  delaySeconds(
    attempt: number,
    context: RetryContext,
    retryAfterSeconds?: number | null,
  ): number;
}

export interface WorkerOptions {
  repository: DeliveryRepository;
  transport: DeliveryTransport;
  signer: DeliverySigner;
  clock: Clock;
  metrics?: MetricsSink;
  retryPolicy?: RetryPolicy;
  workerId: string;
  tenantId?: string;
  consumerId?: string;
  batchSize?: number;
  leaseDurationSeconds?: number;
}

export type WorkerItemOutcome =
  | "acknowledged"
  | "retry_scheduled"
  | "dead_lettered"
  | "stale_lease"
  | "failed";

export interface WorkerItemResult {
  deliveryId: string;
  eventId: string;
  outcome: WorkerItemOutcome;
  attempt: number;
  error?: DeliveryError;
}

export interface WorkerRunResult {
  claimed: number;
  items: readonly WorkerItemResult[];
}

export interface CursorPayload {
  version: "0.1";
  tenantId: string;
  consumerId: string;
  subscriptionId: string;
  selectorVersion: string;
  position: string;
  expiresAt: number;
}

export interface CursorContext {
  tenantId: string;
  consumerId: string;
  subscriptionId: string;
  selectorVersion: string;
  nowSeconds: number;
}

export interface CursorCodec {
  encode(input: Omit<CursorPayload, "version">): string;
  decode(token: string, context: CursorContext): CursorPayload;
}

export type CursorCanonicalizer = (payload: CursorPayload) => string;

export interface PullPage {
  deliveries: readonly DeliveryJob[];
  nextCursor: string | null;
}

export interface PullInput {
  tenantId: string;
  consumerId: string;
  subscriptionId: string;
  selectorVersion: string;
  cursor: string | null;
  limit: number;
  now: string;
}

export class CursorError extends Error {
  readonly code:
  | "invalid_cursor"
  | "cursor_signature_mismatch"
  | "cursor_binding_mismatch"
  | "cursor_expired"
  | "invalid_cursor_payload";

  constructor(code: CursorError["code"], detail?: string) {
    super(detail ? `${code}:${detail}` : code);
    this.name = "CursorError";
    this.code = code;
  }
}
