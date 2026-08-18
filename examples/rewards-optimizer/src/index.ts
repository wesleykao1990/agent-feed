import type { DeliveryEvent, Finding } from "@agent-feed/sdk";

const DELIVERY_EVENT_TYPES = new Set([
  "run.started",
  "finding.submitted",
  "run.completed",
  "run.partial",
  "run.failed",
]);

const FINDING_EVENT_TYPE = "finding.submitted";

export type ReferenceConsumerErrorCode =
  | "invalid_delivery_event"
  | "invalid_finding"
  | "stream_scope_denied"
  | "transport_payload_conflict"
  | "unsupported_event_type";

/**
 * Errors intentionally contain stable, non-sensitive text.  Untrusted source
 * content is never copied into an exception message.
 */
export class ReferenceConsumerError extends Error {
  readonly code: ReferenceConsumerErrorCode;

  constructor(code: ReferenceConsumerErrorCode, message: string) {
    super(message);
    this.name = "ReferenceConsumerError";
    this.code = code;
  }
}

export interface UntrustedSourceObservation {
  /** Stable local identity for this observation, distinct from the transport key. */
  readonly source_observation_id: string;
  /** The transport event that carried the observation. */
  readonly transport: {
    readonly tenant_id: string;
    readonly consumer_id: string;
    readonly event_id: string;
    readonly attempt: number;
    readonly stream_id: string;
    readonly run_id: string;
    readonly occurred_at: string;
  };
  /** The consumer's semantic key; it deliberately does not use event_id. */
  readonly semantic_key: string;
  /** A producer claim.  It is explicitly not verified source truth. */
  readonly finding: Finding;
  /** Submitted evidence is retained as untrusted input, not promoted to canonical evidence. */
  readonly submitted_evidence: readonly unknown[];
  readonly trust: "untrusted";
  readonly promotion_status: "not_promoted";
}

export type IngestDisposition =
  | "accepted_untrusted"
  | "semantic_duplicate"
  | "transport_duplicate"
  | "ignored_event";

export interface IngestResult {
  readonly disposition: IngestDisposition;
  readonly transport_event_id: string;
  readonly semantic_key: string | null;
  readonly observation: UntrustedSourceObservation | null;
}

export interface ReferenceConsumerOptions {
  /** Authenticated consumer scope; it is never taken from the delivery body. */
  readonly tenant_id: string;
  /** Authenticated consumer identity; it is never taken from the delivery body. */
  readonly consumer_id: string;
  /** Non-empty allowlist of streams authorized for this consumer. */
  readonly allowed_stream_ids: readonly string[];
  /**
   * Optional application-owned semantic key function. It receives a Finding
   * only; transport identifiers are intentionally unavailable to this hook.
   */
  readonly semantic_fingerprint?: (finding: Finding) => string;
}

export interface ConsumerScope {
  /** Authenticated tenant scope supplied by the caller, not by event payload. */
  readonly tenant_id: string;
  /** Authenticated consumer identity supplied by the caller. */
  readonly consumer_id: string;
  /** Authenticated stream scope supplied by the caller, not by event payload. */
  readonly allowed_stream_ids: readonly string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringOrNull(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isFindingSubject(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.type === "string" &&
    isStringOrNull(value.id) &&
    isStringOrNull(value.name)
  );
}

function isFindingEffectiveTime(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  return (
    isStringOrNull(value.occurred_at) &&
    isStringOrNull(value.effective_from) &&
    isStringOrNull(value.effective_to)
  );
}

function isFindingAssessment(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  const novelty = value.novelty;
  const completeness = value.evidence_completeness;
  const authority = value.source_authority_claim;
  return (
    (novelty === "new" || novelty === "known" || novelty === "uncertain") &&
    (completeness === "complete" || completeness === "partial" || completeness === "lead_only") &&
    (authority === "primary" ||
      authority === "official_secondary" ||
      authority === "third_party" ||
      authority === "unknown") &&
    (value.agent_confidence === null || typeof value.agent_confidence === "number")
  );
}

function isFinding(value: unknown): value is Finding {
  if (!isRecord(value)) {
    return false;
  }

  return (
    typeof value.finding_id === "string" &&
    typeof value.finding_type === "string" &&
    typeof value.title === "string" &&
    typeof value.summary === "string" &&
    Array.isArray(value.subjects) &&
    value.subjects.every(isFindingSubject) &&
    isFindingEffectiveTime(value.effective_time) &&
    isFindingAssessment(value.assessment) &&
    Array.isArray(value.evidence_refs) &&
    value.evidence_refs.every((item) => typeof item === "string") &&
    isStringOrNull(value.producer_dedupe_key) &&
    Array.isArray(value.routing_tags) &&
    value.routing_tags.every((item) => typeof item === "string") &&
    isRecord(value.attributes) &&
    Array.isArray(value.security_flags) &&
    value.security_flags.every((item) => typeof item === "string")
  );
}

function invalidEvent(): ReferenceConsumerError {
  return new ReferenceConsumerError(
    "invalid_delivery_event",
    "Delivery event failed the required protocol-envelope checks.",
  );
}

function assertScope(value: unknown): asserts value is ConsumerScope {
  if (
    !isRecord(value) ||
    typeof value.tenant_id !== "string" ||
    value.tenant_id.length === 0 ||
    typeof value.consumer_id !== "string" ||
    value.consumer_id.length === 0 ||
    !Array.isArray(value.allowed_stream_ids) ||
    value.allowed_stream_ids.length === 0 ||
    !value.allowed_stream_ids.every((streamId) => typeof streamId === "string" && streamId.length > 0)
  ) {
    throw new ReferenceConsumerError(
      "invalid_delivery_event",
      "Authenticated consumer tenant and stream scope are required.",
    );
  }
}

function assertAllowedStream(event: DeliveryEvent, scope: ConsumerScope): void {
  if (!scope.allowed_stream_ids.includes(event.stream_id)) {
    throw new ReferenceConsumerError(
      "stream_scope_denied",
      "Delivery event stream is outside the authenticated consumer scope.",
    );
  }
}

function assertDeliveryEvent(value: unknown): asserts value is DeliveryEvent {
  if (!isRecord(value)) {
    throw invalidEvent();
  }
  if (value.protocol_version !== "0.1") {
    throw invalidEvent();
  }
  if (typeof value.event_id !== "string" || value.event_id.length === 0) {
    throw invalidEvent();
  }
  if (typeof value.stream_id !== "string" || value.stream_id.length === 0) {
    throw invalidEvent();
  }
  if (typeof value.run_id !== "string" || value.run_id.length === 0) {
    throw invalidEvent();
  }
  if (typeof value.occurred_at !== "string" || value.occurred_at.length === 0) {
    throw invalidEvent();
  }
  if (typeof value.attempt !== "number" || !Number.isInteger(value.attempt) || value.attempt < 1) {
    throw invalidEvent();
  }
  if (typeof value.finding_id !== "string" && value.finding_id !== null) {
    throw invalidEvent();
  }
  if (typeof value.event_type !== "string" || !DELIVERY_EVENT_TYPES.has(value.event_type)) {
    throw invalidEvent();
  }
  if (!isRecord(value.payload)) {
    throw invalidEvent();
  }
}

function readFindingFromEvent(event: DeliveryEvent): Finding {
  const payload = event.payload;
  const finding = payload.finding;
  if (!isFinding(finding) || event.finding_id !== finding.finding_id) {
    throw new ReferenceConsumerError(
      "invalid_finding",
      "Finding payload failed the required protocol checks.",
    );
  }
  return structuredClone(finding);
}

function readSubmittedEvidence(event: DeliveryEvent): readonly unknown[] {
  const submittedEvidence = event.payload.submitted_evidence;
  if (submittedEvidence === undefined) {
    return [];
  }
  if (!Array.isArray(submittedEvidence)) {
    throw new ReferenceConsumerError(
      "invalid_finding",
      "Submitted evidence payload must be an array when present.",
    );
  }
  return structuredClone(submittedEvidence);
}

/**
 * Default semantic identity for this reference consumer.
 *
 * This generic default includes the complete claim proposition while
 * excluding delivery identity, producer-local dedupe, evidence/assessment,
 * and routing/security metadata. A domain app may supply a stricter normalizer.
 */
export function defaultSemanticFingerprint(finding: Finding): string {
  const subjects = finding.subjects
    .map((subject) => ({ type: subject.type, id: subject.id }))
    .sort((left, right) => {
      const leftKey = JSON.stringify(left);
      const rightKey = JSON.stringify(right);
      return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
    });
  return JSON.stringify({
    finding_type: finding.finding_type,
    title: finding.title,
    summary: finding.summary,
    subjects,
    effective_time: finding.effective_time,
    attributes: finding.attributes,
  });
}

function transportDedupeKey(tenantId: string, consumerId: string, eventId: string): string {
  return JSON.stringify({ tenant_id: tenantId, consumer_id: consumerId, event_id: eventId });
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  throw invalidEvent();
}

/**
 * Immutable transport identity for one event. Delivery attempt is excluded so
 * a normal at-least-once retry is accepted, while payload drift under a reused
 * event_id fails closed.
 */
function transportSourceFingerprint(event: DeliveryEvent): string {
  return canonicalJson({
    protocol_version: event.protocol_version,
    event_id: event.event_id,
    event_type: event.event_type,
    stream_id: event.stream_id,
    run_id: event.run_id,
    finding_id: event.finding_id,
    occurred_at: event.occurred_at,
    payload: event.payload,
  });
}

function semanticDedupeKey(
  tenantId: string,
  consumerId: string,
  streamId: string,
  fingerprint: string,
): string {
  return JSON.stringify({
    version: "v1",
    tenant_id: tenantId,
    consumer_id: consumerId,
    stream_id: streamId,
    semantic_fingerprint: fingerprint,
  });
}

function mapDeliveryEventWithFingerprint(
  event: DeliveryEvent,
  scope: ConsumerScope,
  semanticFingerprint: (finding: Finding) => string,
): UntrustedSourceObservation {
  assertScope(scope);
  assertDeliveryEvent(event);
  assertAllowedStream(event, scope);
  if (event.event_type !== FINDING_EVENT_TYPE) {
    throw new ReferenceConsumerError(
      "unsupported_event_type",
      "Only finding.submitted events can be mapped to source observations.",
    );
  }

  const finding = readFindingFromEvent(event);
  const semanticKey = semanticDedupeKey(
    scope.tenant_id,
    scope.consumer_id,
    event.stream_id,
    semanticFingerprint(finding),
  );
  return {
    source_observation_id: `${scope.tenant_id}:${scope.consumer_id}:${event.stream_id}:${event.run_id}:${event.event_id}:${finding.finding_id}`,
    transport: {
      tenant_id: scope.tenant_id,
      consumer_id: scope.consumer_id,
      event_id: event.event_id,
      attempt: event.attempt,
      stream_id: event.stream_id,
      run_id: event.run_id,
      occurred_at: event.occurred_at,
    },
    semantic_key: semanticKey,
    finding,
    submitted_evidence: readSubmittedEvidence(event),
    trust: "untrusted",
    promotion_status: "not_promoted",
  };
}

/**
 * Map one supported delivery event to a source observation.
 *
 * The result is deliberately a holding boundary: callers must verify sources
 * and apply their own domain policy before any downstream use.  This function
 * does not fetch URLs, interpret text, apply rules, or promote evidence.
 */
export function mapDeliveryEvent(
  event: DeliveryEvent,
  scope: ConsumerScope,
): UntrustedSourceObservation {
  return mapDeliveryEventWithFingerprint(event, scope, defaultSemanticFingerprint);
}

export class ReferenceConsumer {
  private readonly transportReceipts = new Map<string, string>();
  private readonly semanticDedupeKeys = new Set<string>();
  private readonly observations = new Map<string, UntrustedSourceObservation>();
  private readonly semanticFingerprint: (finding: Finding) => string;
  private readonly tenant_id: string;
  private readonly consumer_id: string;
  private readonly allowed_stream_ids: ReadonlySet<string>;

  constructor(options: ReferenceConsumerOptions) {
    assertScope(options);
    this.tenant_id = options.tenant_id;
    this.consumer_id = options.consumer_id;
    this.allowed_stream_ids = new Set(options.allowed_stream_ids);
    this.semanticFingerprint = options.semantic_fingerprint ?? defaultSemanticFingerprint;
  }

  ingest(event: DeliveryEvent): IngestResult {
    assertDeliveryEvent(event);
    if (!this.allowed_stream_ids.has(event.stream_id)) {
      throw new ReferenceConsumerError(
        "stream_scope_denied",
        "Delivery event stream is outside the authenticated consumer scope.",
      );
    }
    const transportKey = transportDedupeKey(this.tenant_id, this.consumer_id, event.event_id);
    const sourceFingerprint = transportSourceFingerprint(event);
    const priorFingerprint = this.transportReceipts.get(transportKey);
    if (priorFingerprint !== undefined) {
      if (priorFingerprint !== sourceFingerprint) {
        throw new ReferenceConsumerError(
          "transport_payload_conflict",
          "Delivery event reused an event identifier with different immutable content.",
        );
      }
      return {
        disposition: "transport_duplicate",
        transport_event_id: event.event_id,
        semantic_key: null,
        observation: null,
      };
    }

    if (event.event_type !== FINDING_EVENT_TYPE) {
      this.transportReceipts.set(transportKey, sourceFingerprint);
      return {
        disposition: "ignored_event",
        transport_event_id: event.event_id,
        semantic_key: null,
        observation: null,
      };
    }

    const observation = mapDeliveryEventWithFingerprint(
      event,
      {
        tenant_id: this.tenant_id,
        consumer_id: this.consumer_id,
        allowed_stream_ids: [...this.allowed_stream_ids],
      },
      this.semanticFingerprint,
    );
    this.transportReceipts.set(transportKey, sourceFingerprint);
    const semanticDuplicate = this.semanticDedupeKeys.has(observation.semantic_key);
    this.semanticDedupeKeys.add(observation.semantic_key);
    this.observations.set(observation.source_observation_id, observation);

    return {
      disposition: semanticDuplicate ? "semantic_duplicate" : "accepted_untrusted",
      transport_event_id: event.event_id,
      semantic_key: observation.semantic_key,
      observation,
    };
  }

  get transport_event_count(): number {
    return this.transportReceipts.size;
  }

  get semantic_key_count(): number {
    return this.semanticDedupeKeys.size;
  }

  get observation_count(): number {
    return this.observations.size;
  }

  hasTransportEvent(eventId: string): boolean {
    return this.transportReceipts.has(
      transportDedupeKey(this.tenant_id, this.consumer_id, eventId),
    );
  }

  hasSemanticKey(semanticKey: string): boolean {
    return this.semanticDedupeKeys.has(semanticKey);
  }

  listObservations(): readonly UntrustedSourceObservation[] {
    return [...this.observations.values()];
  }
}
