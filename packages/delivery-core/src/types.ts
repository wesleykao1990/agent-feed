export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export type JsonObject = { [key: string]: JsonValue };

export const DELIVERY_EVENT_TYPES = [
  "run.started",
  "finding.submitted",
  "run.completed",
  "run.partial",
  "run.failed",
] as const;

export type DeliveryEventType = (typeof DELIVERY_EVENT_TYPES)[number];
export type SubscriptionStatus = "active" | "paused" | "revoked";

export interface NormalizedRoutingTagSelector {
  mode: "any" | "all";
  values: string[];
}
/** Canonical selector shape shared with the consumer application contract. */
export interface NormalizedSubscriptionSelector {
  /** Required exact stream allowlist; an empty list is invalid, never a wildcard. */
  streamIds: string[];
  /** Null means any finding type; values are ORed. */
  findingTypes: string[] | null;
  /** Null means no tag constraint; values use explicit any/all semantics. */
  routingTags: NormalizedRoutingTagSelector | null;
  /** At least one pinned protocol event type. */
  eventTypes: DeliveryEventType[];
}

export type DeliveryState =
  | "queued"
  | "retry_wait"
  | "leased"
  | "acknowledged"
  | "dead_letter";

/**
 * Immutable internal source event. `attempt` is intentionally absent: retry
 * attempt metadata belongs to the signed webhook envelope, never to the
 * source event identity or payload hash.
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
  traceId: string | null;
  payload: JsonObject;
  payloadHash: string;
  /** Materialized selector metadata; terminal events use null/empty values. */
  findingType: string | null;
  routingTags: readonly string[];
  /** Quarantined events remain auditable but are not faned out. */
  deliveryEligible: boolean;
}

export interface ConsumerSubscription {
  tenantId: string;
  consumerId: string;
  subscriptionId: string;
  selectorVersion: number;
  selectors: NormalizedSubscriptionSelector;
  /** Outbox position captured at creation/update; matching is future-only. */
  activationPosition: string;
  status: SubscriptionStatus;
  endpoint: DeliveryEndpoint | null;
}

export interface DeliveryEndpoint {
  /** An adapter-owned endpoint reference; core never resolves or fetches it. */
  endpointRef: string;
  /** Key reference; key material stays in the injected signer/runtime. */
  signingKeyId: string | null;
}

export interface DeliveryJob {
  deliveryId: string;
  tenantId: string;
  consumerId: string;
  subscriptionId: string;
  eventId: string;
  traceId: string | null;
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

/** Signed attempt envelope returned by the shared protocol runtime adapter. */
export interface SignedDelivery {
  eventId: string;
  deliveryId: string;
  rawBody: string;
  signature: string;
  timestampSeconds: number;
  attempt: number;
  replayGeneration: number;
  traceId: string | null;
  keyId: string;
  headers: Readonly<Record<string, string>>;
}

export interface DeliveryTransportRequest {
  endpoint: DeliveryEndpoint;
  eventId: string;
  deliveryId: string;
  traceId: string | null;
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
  tenantId: string;
  consumerId: string;
  subscriptionId: string;
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
  subscriptionId: string;
  deliveryId: string;
  requestedAt: string;
  reason: string;
  idempotencyKey: string;
  payloadHash: string;
}

export interface DeliveryRepository {
  /**
   * Called from the same transaction that accepts the producer record. The
   * adapter must persist the immutable event and matching delivery rows before
   * returning. The adapter obtains the active, versioned subscription snapshot
   * transactionally; the core port deliberately does not accept a caller-owned
   * snapshot that could be stale or incomplete.
   */
  appendOutboxEvent(event: DeliveryEvent): Promise<void>;
  /** Claim uses a short DB transaction; the lease remains valid during I/O. */
  claimDue(input: LeaseClaimInput): Promise<readonly DeliveryClaim[]>;
  /** Every mutation must compare scope, lease token, attempt, and generation. */
  acknowledge(input: AcknowledgeInput): Promise<LeaseTransitionResult>;
  scheduleRetry(input: RetryInput): Promise<LeaseTransitionResult>;
  deadLetter(input: DeadLetterInput): Promise<LeaseTransitionResult>;
  recoverExpiredLeases(input: { now: string; limit: number }): Promise<number>;
  replay(input: ReplayInput): Promise<DeliveryJob>;
  /**
   * Pull is cursor-opaque at this port. The adapter/application boundary must
   * inject a CursorCodec (normally BoundCursorCodec) and use it for both
   * decoding `input.cursor` and encoding `PullPage.nextCursor`; raw unsigned
   * JSON/base64 cursor helpers are not a valid implementation.
   */
  pull(input: PullInput): Promise<PullPage>;
}

export interface DeliveryQueue {
  /** A queue message is only a wake-up hint; the repository is authoritative. */
  enqueue(deliveryId: string): Promise<void>;
}

export interface DeliverySigner {
  /**
   * The adapter maps the immutable event to protocol-runtime wire fields,
   * including the current attempt. The runtime owns canonical JSON/HMAC.
   */
  sign(input: {
    event: DeliveryEvent;
    subscription: ConsumerSubscription;
    deliveryId: string;
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
  classify(result: DeliveryTransportResponse | unknown, now: Date): RetryDecision;
  delaySeconds(attempt: number, context: RetryContext, retryAfterSeconds?: number | null): number;
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
  version: 1;
  tenantId: string;
  consumerId: string;
  subscriptionId: string;
  selectorVersion: number;
  /** Tenant-global, monotonically increasing decimal delivery position. */
  position: string;
  expiresAt: number;
}

export interface CursorCodec {
  encode(claims: CursorPayload): string;
  decode(token: string): CursorPayload;
}

/** Runtime-owned canonicalizer; delivery-core does not duplicate canonical JSON. */
export type CursorCanonicalizer = (payload: CursorPayload) => string;

/** Runtime-owned HMAC/signature seam; implementations may use protocol-runtime. */
export interface CursorSigner {
  sign(canonicalPayload: string): string;
  verify(canonicalPayload: string, signature: string): boolean;
}

export interface CursorScope {
  tenantId: string;
  consumerId: string;
  subscriptionId: string;
  selectorVersion: number;
}

export interface PullPage {
  /** Delivery rows in stable tenant-global position order. */
  deliveries: readonly DeliveryJob[];
  /** Opaque token produced by the same injected CursorCodec, or null at EOF. */
  nextCursor: string | null;
}

export interface PullInput {
  tenantId: string;
  consumerId: string;
  subscriptionId: string;
  selectorVersion: number;
  /** Opaque token; do not parse or construct this value with ad-hoc JSON. */
  cursor: string | null;
  limit: number;
  now: string;
}

export class CursorError extends Error {
  readonly code:
  | "invalid_cursor"
  | "cursor_signature_mismatch"
  | "cursor_scope_mismatch"
  | "cursor_expired"
  | "invalid_cursor_payload";

  constructor(code: CursorError["code"], detail?: string) {
    super(detail ? `${code}:${detail}` : code);
    this.name = "CursorError";
    this.code = code;
  }
}
