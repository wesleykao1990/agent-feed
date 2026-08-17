import {
  decodeDeliveryEvent,
  sha256Hex,
  signDeliveryEvent,
  type DeliveryEventWire,
  type KeyRing,
  type SignedDelivery as RuntimeSignedDelivery,
} from "@agent-feed/protocol-runtime";
import type {
  ConsumerSubscription,
  DeliveryEndpoint,
  DeliveryEvent,
  DeliverySigner,
  SignedDelivery,
} from "@agent-feed/delivery-core";

export interface DeliveryKeyResolver {
  /** Resolve key material without exposing it to the worker or logs. */
  resolve(input: { endpoint: DeliveryEndpoint; keyId: string | null }): KeyRing;
}

/** A small DI helper for local deployments; production can wrap a secret manager. */
export class StaticDeliveryKeyResolver implements DeliveryKeyResolver {
  readonly #rings: ReadonlyMap<string, KeyRing>;

  constructor(rings: ReadonlyMap<string, KeyRing>) {
    this.#rings = new Map(rings);
  }

  resolve(input: { endpoint: DeliveryEndpoint; keyId: string | null }): KeyRing {
    const ring = this.#rings.get(input.endpoint.endpointRef);
    if (!ring) throw new Error("signing_key_unavailable");
    return ring;
  }
}

function protocolTraceId(event: DeliveryEvent, deliveryId: string): string | undefined {
  if (event.traceId === null) return undefined;
  if (/^[0-9a-f]{32}$/u.test(event.traceId) && !/^0{32}$/u.test(event.traceId)) return event.traceId;
  // The internal contract permits opaque trace IDs; derive a valid W3C ID at
  // the protocol boundary while keeping the original ID in the core result.
  return sha256Hex(`agent-feed.trace:${event.traceId}:${deliveryId}`).slice(0, 32);
}

function spanId(deliveryId: string, attempt: number): string {
  return sha256Hex(`agent-feed.span:${deliveryId}:${attempt}`).slice(0, 16);
}

function assertSignedRuntimeInvariant(
  runtime: RuntimeSignedDelivery,
  wireEvent: DeliveryEventWire,
  deliveryId: string,
  traceId: string | undefined,
): void {
  let decoded: DeliveryEventWire;
  try {
    decoded = decodeDeliveryEvent(runtime.rawBody);
  } catch {
    throw new Error("signed_delivery_invariant");
  }
  if (
    decoded.event_id !== wireEvent.event_id
    || decoded.attempt !== wireEvent.attempt
    || decoded.protocol_version !== wireEvent.protocol_version
  ) {
    throw new Error("signed_delivery_invariant");
  }

  const headers = runtime.headers;
  const expected: Readonly<Record<string, string>> = {
    "x-agent-feed-event-id": decoded.event_id,
    "x-agent-feed-delivery-id": deliveryId,
    "x-agent-feed-attempt": String(decoded.attempt),
    "x-agent-feed-protocol-version": decoded.protocol_version,
    "x-agent-feed-timestamp": String(runtime.timestampSeconds),
    "x-agent-feed-key-id": runtime.keyId,
    "x-agent-feed-signature": runtime.signature,
  };
  for (const [name, value] of Object.entries(expected)) {
    if (headers[name] !== value) throw new Error("signed_delivery_invariant");
  }

  const expectedTraceparent = traceId === undefined
    ? undefined
    : `00-${traceId}-${spanId(deliveryId, decoded.attempt)}-01`;
  if (headers["x-agent-feed-trace-id"] !== traceId) throw new Error("signed_delivery_invariant");
  if (headers.traceparent !== expectedTraceparent) throw new Error("signed_delivery_invariant");

  // Replay generation is a core lease/state value, not a protocol-0.1 wire
  // field or header. Reject accidental introduction rather than creating an
  // undocumented second replay identity.
  if (headers["x-agent-feed-replay-generation"] !== undefined) throw new Error("signed_delivery_invariant");
}

export interface ProtocolDeliverySignerOptions {
  keyResolver: DeliveryKeyResolver;
}

/** Maps the immutable core event to the strict protocol-0.1 wire envelope. */
export class ProtocolDeliverySigner implements DeliverySigner {
  readonly #keyResolver: DeliveryKeyResolver;

  constructor(options: ProtocolDeliverySignerOptions) {
    this.#keyResolver = options.keyResolver;
  }

  sign(input: {
    event: DeliveryEvent;
    subscription: ConsumerSubscription;
    deliveryId: string;
    attempt: number;
    replayGeneration: number;
    timestampSeconds: number;
  }): SignedDelivery {
    if (!input.event.deliveryEligible) throw new Error("event_not_delivery_eligible");
    const endpoint = input.subscription.endpoint;
    if (endpoint === null) throw new Error("delivery_endpoint_missing");
    if (!Number.isSafeInteger(input.attempt) || input.attempt < 1) throw new Error("invalid_delivery_attempt");
    if (!Number.isSafeInteger(input.replayGeneration) || input.replayGeneration < 0) {
      throw new Error("invalid_replay_generation");
    }
    const traceId = protocolTraceId(input.event, input.deliveryId);
    const wireEvent: DeliveryEventWire = {
      protocol_version: "0.1",
      event_id: input.event.eventId,
      event_type: input.event.eventType,
      stream_id: input.event.streamId,
      run_id: input.event.runId,
      finding_id: input.event.findingId,
      occurred_at: input.event.occurredAt,
      attempt: input.attempt,
      payload: input.event.payload,
    };
    let ring: KeyRing;
    try {
      ring = this.#keyResolver.resolve({ endpoint, keyId: endpoint.signingKeyId });
    } catch {
      // Resolver failures can contain secret-manager URLs or diagnostics.
      // Never let those strings reach delivery-core persistence/logging.
      throw new Error("signing_key_unavailable");
    }

    let runtime: RuntimeSignedDelivery;
    try {
      runtime = signDeliveryEvent(wireEvent, ring, {
        deliveryId: input.deliveryId,
        timestampSeconds: input.timestampSeconds,
        ...(endpoint.signingKeyId === null ? {} : { keyId: endpoint.signingKeyId }),
        ...(traceId === undefined ? {} : {
          traceId,
          traceparent: `00-${traceId}-${spanId(input.deliveryId, input.attempt)}-01`,
        }),
      });
    } catch (error) {
      // Preserve only the stable key-availability outcome. Other runtime
      // failures are intentionally generic and cannot expose input/secret
      // material through an Error.message.
      if (error instanceof Error && error.message === "no_valid_signing_key") {
        throw new Error("signing_key_unavailable");
      }
      throw new Error("signing_failed");
    }
    try {
      assertSignedRuntimeInvariant(runtime, wireEvent, input.deliveryId, traceId);
    } catch {
      throw new Error("signed_delivery_invariant");
    }
    return {
      eventId: input.event.eventId,
      deliveryId: input.deliveryId,
      rawBody: runtime.rawBody,
      signature: runtime.signature,
      timestampSeconds: runtime.timestampSeconds,
      attempt: input.attempt,
      replayGeneration: input.replayGeneration,
      traceId: input.event.traceId,
      keyId: runtime.keyId,
      headers: runtime.headers,
    };
  }
}
