import { randomUUID } from "node:crypto";
import type { PoolClient, QueryResultRow } from "pg";
import { assertCursorScope } from "@agent-feed/delivery-core";
import type { CursorCodec, CursorPayload } from "@agent-feed/delivery-core";
import { payloadHash } from "./hash.ts";
import type { PgPool } from "./types.ts";
import type {
  AcknowledgeInput,
  ConsumerSubscription,
  DeadLetterInput,
  DeliveryClaim,
  DeliveryEndpoint,
  DeliveryError,
  DeliveryEvent,
  DeliveryEventType,
  DeliveryJob,
  DeliveryRepository,
  LeaseClaimInput,
  LeaseOutcomeInput,
  LeaseTransitionResult,
  PullInput,
  PullPage,
  ReplayInput,
  RetryInput,
  SubscriptionInput,
  SubscriptionSelectors,
  SubscriptionStatus,
} from "./delivery-types.ts";

type DbRow = QueryResultRow & Record<string, unknown>;

function date(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();
}

function requiredDate(value: unknown, field: string): string {
  const result = date(value);
  if (result === null) throw new Error(`database returned null ${field}`);
  return result;
}

function int(value: unknown): number {
  const result = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(result)) throw new Error(`database returned invalid integer ${String(value)}`);
  return result;
}

function text(value: unknown): string {
  return String(value);
}

function json(value: unknown): string {
  return JSON.stringify(value);
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function asEventType(value: string): DeliveryEventType {
  if (["run.started", "finding.submitted", "run.completed", "run.partial", "run.failed"].includes(value)) {
    return value as DeliveryEventType;
  }
  throw new Error(`invalid event type ${value}`);
}

function asEventTypes(value: unknown): DeliveryEventType[] {
  return asStringArray(value).map(asEventType);
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function asError(code: unknown, detail: unknown, status: unknown, hash: unknown): DeliveryError | null {
  if (code === null || code === undefined) return null;
  return {
    code: text(code),
    message: detail === null || detail === undefined ? text(code) : text(detail),
    retryable: true,
    status: status === null || status === undefined ? null : int(status),
    ...(hash === null || hash === undefined ? {} : { responseBodyHash: text(hash) }),
  };
}

function durableError(error: DeliveryError): DeliveryError {
  const code = typeof error.code === "string" && /^[a-z0-9_.-]{1,64}$/u.test(error.code)
    ? error.code
    : "delivery_error";
  const responseBodyHash = typeof error.responseBodyHash === "string"
    && /^[a-f0-9]{64}$/u.test(error.responseBodyHash)
    ? error.responseBodyHash
    : undefined;
  return {
    code,
    message: "delivery attempt failed",
    retryable: error.retryable === true,
    status: Number.isSafeInteger(error.status) && (error.status as number) >= 100 && (error.status as number) <= 599
      ? error.status
      : null,
    ...(responseBodyHash === undefined ? {} : { responseBodyHash }),
  };
}

function state(value: unknown): DeliveryJob["state"] {
  if (value === "pending") return "queued";
  if (value === "in_flight") return "leased";
  if (value === "retry_wait" || value === "acknowledged" || value === "dead_letter") return value;
  throw new Error(`invalid delivery state ${String(value)}`);
}

function status(active: unknown): SubscriptionStatus {
  return active === true ? "active" : "paused";
}

function uuidOrNull(value: string | null | undefined): string | null {
  if (!value) return null;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value) ? value : null;
}

function endpointFromInput(input: SubscriptionInput): { url: string | null; secret: string | null; endpoint: DeliveryEndpoint | null } {
  if (input.deliveryMode === "pull") return { url: null, secret: null, endpoint: null };
  const endpoint = input.endpoint ?? null;
  const url = endpoint?.endpointRef ?? null;
  const secret = endpoint?.signingKeyId ?? null;
  if (!url || !secret) throw new Error("webhook subscriptions require endpointRef and signingKeyId");
  return { url, secret, endpoint: { endpointRef: url, signingKeyId: secret } };
}

function validateSelector(input: SubscriptionInput): SubscriptionSelectors {
  if (!input.tenantId || !input.consumerId) throw new Error("tenant and consumer scope are required");
  const streams = [...new Set(input.streamIds)].filter((item) => item.length > 0);
  if (streams.length === 0) throw new Error("stream_ids_must_not_be_empty");
  const findingTypes = input.findingTypes === undefined || input.findingTypes === null
    ? null
    : [...new Set(input.findingTypes)].filter((item) => item.length > 0);
  const routingTags = input.routingTags === undefined || input.routingTags === null
    ? null
    : {
      mode: input.routingTags.mode,
      values: [...new Set(input.routingTags.values)].filter((item) => item.length > 0),
    };
  if (routingTags && routingTags.values.length === 0) throw new Error("routing tag selector cannot be empty");
  const allowedEventTypes = new Set<DeliveryEventType>([
    "run.started", "finding.submitted", "run.completed", "run.partial", "run.failed",
  ]);
  if (input.eventTypes?.some((eventType) => !allowedEventTypes.has(eventType))) {
    throw new Error("event_type_invalid");
  }
  return {
    streamIds: streams,
    findingTypes,
    routingTags,
    eventTypes: input.eventTypes && input.eventTypes.length > 0
      ? [...new Set(input.eventTypes)]
      : ["run.started", "finding.submitted", "run.completed", "run.partial", "run.failed"],
  };
}

/**
 * Persist an immutable source event and atomically fan it out.  Ingress calls
 * this with the same PoolClient that accepted the producer rows; the helper
 * intentionally does not begin or commit a transaction itself.
 */
export async function appendOutboxEventInTransaction(
  client: PoolClient,
  event: DeliveryEvent,
): Promise<void> {
  const findingDbId = event.databaseFindingId ?? uuidOrNull(event.findingId);
  const eligible = event.deliveryEligible;
  const canonicalEventPayloadHash = payloadHash(event.payload);
  if (event.payloadHash && event.payloadHash !== canonicalEventPayloadHash) {
    throw new Error("outbox_event_payload_hash_mismatch");
  }
  const eventPayloadHash = canonicalEventPayloadHash;
  const inserted = await client.query<{ event_id: string }>(
    `insert into agent_feed.outbox_events (
       id, tenant_id, event_id, event_key, event_type, protocol_version,
       stream_id, run_id, finding_id, wire_finding_id, finding_type,
       routing_tags, payload, occurred_at, payload_hash, delivery_eligibility,
       quarantine_reason, trace_id
     ) values (
       $1, $2, $3, $4, $5, '0.1', $6, $7, $8, $9, $10,
       $11::jsonb, $12::jsonb, $13, $14, $15, $16, $17
     )
     on conflict (tenant_id, event_key) do nothing
     returning event_id`,
    [
      randomUUID(), event.tenantId, event.eventId, event.eventId, event.eventType,
      event.streamId, event.runId, findingDbId, event.findingId, event.findingType,
      json(event.routingTags), json(event.payload), new Date(event.occurredAt),
      eventPayloadHash, eligible ? "eligible" : "quarantined",
      eligible ? null : "event marked ineligible by ingress policy", event.traceId,
    ],
  );
  let eventId = inserted.rows[0]?.event_id;
  if (!eventId) {
    const existing = await client.query<{
      event_id: string;
      event_type: string;
      protocol_version: string;
      stream_id: string;
      run_id: string;
      finding_id: string | null;
      wire_finding_id: string | null;
      finding_type: string | null;
      routing_tags: unknown;
      payload: unknown;
      occurred_at: Date | string;
      payload_hash: string;
      delivery_eligibility: string;
      trace_id: string | null;
    }>(
      `select event_id, event_type, protocol_version, stream_id, run_id::text,
              finding_id::text, wire_finding_id, finding_type, routing_tags,
              payload, occurred_at, payload_hash, delivery_eligibility, trace_id
         from agent_feed.outbox_events
        where tenant_id = $1 and event_key = $2 for update`,
      [event.tenantId, event.eventId],
    );
    const row = existing.rows[0];
    const existingTags = Array.isArray(row?.routing_tags) ? row.routing_tags : [];
    const expectedTags = [...event.routingTags];
    const sameTags = JSON.stringify(existingTags) === JSON.stringify(expectedTags);
    const samePayload = row?.payload !== undefined && payloadHash(
      row.payload && typeof row.payload === "object" && !Array.isArray(row.payload)
        ? row.payload as Record<string, unknown>
        : {},
    ) === canonicalEventPayloadHash;
    const sameOccurredAt = row?.occurred_at !== undefined
      && new Date(row.occurred_at).getTime() === new Date(event.occurredAt).getTime();
    if (!row
      || row.event_id !== event.eventId
      || row.event_type !== event.eventType
      || row.protocol_version !== "0.1"
      || row.stream_id !== event.streamId
      || row.run_id !== event.runId
      || row.finding_id !== findingDbId
      || row.wire_finding_id !== event.findingId
      || row.finding_type !== event.findingType
      || !sameTags
      || !samePayload
      || !sameOccurredAt
      || row.payload_hash !== eventPayloadHash
      || row.delivery_eligibility !== (eligible ? "eligible" : "quarantined")
      || (event.traceId !== null && row.trace_id !== event.traceId)) {
      throw new Error("outbox_event_idempotency_conflict");
    }
    eventId = row.event_id;
  }
  if (!eventId) throw new Error("outbox_event_missing_after_insert");

  // Selector matching is normalized and evaluated from the version snapshot.
  // Empty selector kinds are wildcards. Routing tags support explicit any/all.
  await client.query(
    `insert into agent_feed.consumer_deliveries (
       tenant_id, consumer_id, subscription_id, selector_version, event_id,
       state, attempt_count, next_attempt_at
     )
     select v.tenant_id, v.consumer_id, v.subscription_id, v.selector_version,
            e.event_id, 'pending', 0, now()
       from agent_feed.outbox_events e
       join agent_feed.consumer_subscription_versions v
         on v.tenant_id = e.tenant_id
        and v.active
        and e.delivery_position > v.activation_position
       join agent_feed.consumer_subscriptions s
         on s.tenant_id = v.tenant_id
        and s.consumer_id = v.consumer_id
        and s.id = v.subscription_id
        and s.enabled
        and s.status = 'active'
      where e.tenant_id = $1
        and e.event_id = $2
        and e.delivery_eligibility = 'eligible'
        and (e.finding_id is not null or v.include_run_events)
        and (not exists (
               select 1 from agent_feed.consumer_subscription_selectors x
                where x.tenant_id = v.tenant_id and x.consumer_id = v.consumer_id
                  and x.subscription_id = v.subscription_id
                  and x.selector_version = v.selector_version
                  and x.selector_kind = 'stream_id'
             ) or exists (
               select 1 from agent_feed.consumer_subscription_selectors x
                where x.tenant_id = v.tenant_id and x.consumer_id = v.consumer_id
                  and x.subscription_id = v.subscription_id
                  and x.selector_version = v.selector_version
                  and x.selector_kind = 'stream_id'
                  and x.selector_value = e.stream_id
             ))
        and (not exists (
               select 1 from agent_feed.consumer_subscription_selectors x
                where x.tenant_id = v.tenant_id and x.consumer_id = v.consumer_id
                  and x.subscription_id = v.subscription_id
                  and x.selector_version = v.selector_version
                  and x.selector_kind = 'event_type'
             ) or exists (
               select 1 from agent_feed.consumer_subscription_selectors x
                where x.tenant_id = v.tenant_id and x.consumer_id = v.consumer_id
                  and x.subscription_id = v.subscription_id
                  and x.selector_version = v.selector_version
                  and x.selector_kind = 'event_type'
                  and x.selector_value = e.event_type
             ))
        and (
          e.event_type <> 'finding.submitted'
          or (
            not exists (
              select 1 from agent_feed.consumer_subscription_selectors x
               where x.tenant_id = v.tenant_id and x.consumer_id = v.consumer_id
                 and x.subscription_id = v.subscription_id
                 and x.selector_version = v.selector_version
                 and x.selector_kind = 'finding_type'
            )
            or exists (
              select 1 from agent_feed.consumer_subscription_selectors x
               where x.tenant_id = v.tenant_id and x.consumer_id = v.consumer_id
                 and x.subscription_id = v.subscription_id
                 and x.selector_version = v.selector_version
                 and x.selector_kind = 'finding_type'
                 and x.selector_value = coalesce(e.finding_type, '')
            )
          )
        )
        and (
          e.event_type <> 'finding.submitted'
          or (
            not exists (
              select 1 from agent_feed.consumer_subscription_selectors x
               where x.tenant_id = v.tenant_id and x.consumer_id = v.consumer_id
                 and x.subscription_id = v.subscription_id
                 and x.selector_version = v.selector_version
                 and x.selector_kind = 'routing_tag'
            )
            or exists (
              select 1 from agent_feed.consumer_subscription_selectors x
               where x.tenant_id = v.tenant_id and x.consumer_id = v.consumer_id
                 and x.subscription_id = v.subscription_id
                 and x.selector_version = v.selector_version
                 and x.selector_kind = 'routing_tag'
                 and x.match_mode = 'any'
                 and e.routing_tags ? x.selector_value
            )
            or (
              exists (
                select 1 from agent_feed.consumer_subscription_selectors x
                 where x.tenant_id = v.tenant_id and x.consumer_id = v.consumer_id
                   and x.subscription_id = v.subscription_id
                   and x.selector_version = v.selector_version
                   and x.selector_kind = 'routing_tag' and x.match_mode = 'all'
              )
              and not exists (
                select 1 from agent_feed.consumer_subscription_selectors x
                 where x.tenant_id = v.tenant_id and x.consumer_id = v.consumer_id
                   and x.subscription_id = v.subscription_id
                   and x.selector_version = v.selector_version
                   and x.selector_kind = 'routing_tag' and x.match_mode = 'all'
                   and not (e.routing_tags ? x.selector_value)
              )
            )
          )
        )
     on conflict (tenant_id, subscription_id, event_id) do nothing`,
    [event.tenantId, eventId],
  );
}

export class PostgresDeliveryRepository implements DeliveryRepository {
  readonly pool: PgPool;
  readonly #cursorCodec: CursorCodec | null;
  readonly #cursorTtlSeconds: number;
  readonly #nowSeconds: () => number;

  constructor(pool: PgPool, options: {
    /** Runtime-owned signed/expiring cursor implementation. */
    cursorCodec?: CursorCodec;
    cursorTtlSeconds?: number;
    nowSeconds?: () => number;
  } = {}) {
    this.pool = pool;
    this.#cursorCodec = options.cursorCodec ?? null;
    this.#cursorTtlSeconds = options.cursorTtlSeconds ?? 900;
    this.#nowSeconds = options.nowSeconds ?? (() => Math.floor(Date.now() / 1000));
    if (!Number.isSafeInteger(this.#cursorTtlSeconds) || this.#cursorTtlSeconds < 1) {
      throw new Error("cursor_ttl_invalid");
    }
  }

  async appendOutboxEvent(event: DeliveryEvent): Promise<void> {
    await this.withTransaction(async (client) => appendOutboxEventInTransaction(client, event));
  }

  async registerSubscription(input: SubscriptionInput): Promise<ConsumerSubscription> {
    const selectors = validateSelector(input);
    const endpoint = endpointFromInput(input);
    const subscriptionId = input.subscriptionId ?? randomUUID();
    const version = input.selectorVersion ?? 1;
    if (!Number.isSafeInteger(version) || version < 1) throw new Error("selectorVersion must be a positive integer");
    return this.withTransaction(async (client) => {
      const activationPosition = await this.lockTenantPosition(client, input.tenantId);
      await client.query(
        `insert into agent_feed.consumer_subscriptions (
           id, tenant_id, consumer_id, stream_id, finding_type, routing_tag,
           selector_version, delivery_mode, endpoint_url, signing_secret_ref,
           enabled, status, starts_at, include_run_events, event_types, routing_tag_match
         ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, case when $11 then 'active' else 'paused' end, $12, $13, $14::jsonb, $15)
         on conflict (tenant_id, id) do nothing`,
        [
          subscriptionId, input.tenantId, input.consumerId, selectors.streamIds[0] ?? "*",
          selectors.findingTypes?.[0] ?? null, selectors.routingTags?.values[0] ?? null,
          version, input.deliveryMode, endpoint.url, endpoint.secret, input.active ?? true,
          input.startsAt ? new Date(input.startsAt) : new Date(), input.includeRunEvents ?? true,
          json(selectors.eventTypes), selectors.routingTags?.mode ?? "any",
        ],
      );
      await this.insertSubscriptionVersion(client, input, subscriptionId, version, activationPosition, selectors, endpoint, input.active ?? true);
      return this.loadSubscription(client, input.tenantId, input.consumerId, subscriptionId, version);
    });
  }

  async addSubscriptionVersion(input: SubscriptionInput & { subscriptionId: string }): Promise<ConsumerSubscription> {
    const selectors = validateSelector(input);
    const endpoint = endpointFromInput(input);
    const version = input.selectorVersion;
    if (version === undefined || !Number.isSafeInteger(version) || version < 1) throw new Error("selectorVersion is required");
    return this.withTransaction(async (client) => {
      const existing = await client.query<DbRow>(
        `select id from agent_feed.consumer_subscriptions
          where tenant_id = $1 and consumer_id = $2 and id = $3 for update`,
        [input.tenantId, input.consumerId, input.subscriptionId],
      );
      if (!existing.rows[0]) throw new Error("subscription_not_found");
      const activationPosition = await this.lockTenantPosition(client, input.tenantId);
      await client.query(
        `update agent_feed.consumer_subscription_versions
            set active = false, active_until = coalesce(active_until, now()), updated_at = now()
          where tenant_id = $1 and consumer_id = $2 and subscription_id = $3 and active`,
        [input.tenantId, input.consumerId, input.subscriptionId],
      );
      await this.insertSubscriptionVersion(client, input, input.subscriptionId, version, activationPosition, selectors, endpoint, input.active ?? true);
      await client.query(
        `update agent_feed.consumer_subscriptions
            set enabled = $4, status = case when $4 then 'active' else 'paused' end,
                delivery_mode = $5, endpoint_url = $6, signing_secret_ref = $7,
                updated_at = now(), selector_updated_at = now()
          where tenant_id = $1 and consumer_id = $2 and id = $3::uuid`,
        [input.tenantId, input.consumerId, input.subscriptionId, input.active ?? true,
          input.deliveryMode, endpoint.url, endpoint.secret],
      );
      return this.loadSubscription(client, input.tenantId, input.consumerId, input.subscriptionId, version);
    });
  }

  async createSubscription(input: SubscriptionInput): Promise<ConsumerSubscription> {
    return this.registerSubscription(input);
  }

  private async insertSubscriptionVersion(
    client: PoolClient,
    input: SubscriptionInput,
    subscriptionId: string,
    version: number,
    activationPosition: string,
    selectors: SubscriptionSelectors,
    endpoint: { url: string | null; secret: string | null },
    active: boolean,
  ): Promise<void> {
    await client.query(
      `insert into agent_feed.consumer_subscription_versions (
         tenant_id, consumer_id, subscription_id, selector_version,
         active_from, activation_position, include_run_events, active,
         delivery_mode, endpoint_url, signing_secret_ref
       ) values ($1, $2, $3, $4, now(), $5, $6, $7, $8, $9, $10)`,
      [input.tenantId, input.consumerId, subscriptionId, version, activationPosition,
        input.includeRunEvents ?? true, active, input.deliveryMode, endpoint.url, endpoint.secret],
    );
    const rows: Array<[string, string[]]> = [
      ["stream_id", selectors.streamIds],
      ["finding_type", selectors.findingTypes ?? []],
      ["event_type", selectors.eventTypes],
    ];
    for (const [kind, values] of rows) {
      for (const value of values) {
        await client.query(
          `insert into agent_feed.consumer_subscription_selectors (
             tenant_id, consumer_id, subscription_id, selector_version,
             selector_kind, selector_value, match_mode
           ) values ($1, $2, $3, $4, $5, $6, 'any')`,
          [input.tenantId, input.consumerId, subscriptionId, version, kind, value],
        );
      }
    }
    for (const value of selectors.routingTags?.values ?? []) {
      await client.query(
        `insert into agent_feed.consumer_subscription_selectors (
           tenant_id, consumer_id, subscription_id, selector_version,
           selector_kind, selector_value, match_mode
         ) values ($1, $2, $3, $4, 'routing_tag', $5, $6)`,
        [input.tenantId, input.consumerId, subscriptionId, version, value, selectors.routingTags?.mode ?? "any"],
      );
    }
  }

  private async lockTenantPosition(client: PoolClient, tenantId: string): Promise<string> {
    await client.query(
      `insert into agent_feed.tenant_event_counters (tenant_id, last_position)
       values ($1, 0) on conflict (tenant_id) do nothing`, [tenantId],
    );
    const rows = await client.query<{ last_position: string | number }>(
      `select last_position from agent_feed.tenant_event_counters where tenant_id = $1 for update`, [tenantId],
    );
    return text(rows.rows[0]?.last_position ?? "0");
  }

  async claimDue(input: LeaseClaimInput): Promise<readonly DeliveryClaim[]> {
    const limit = Math.min(Math.max(Math.trunc(input.limit), 1), 500);
    const leaseSeconds = Math.max(Math.trunc(input.leaseDurationSeconds), 1);
    return this.withTransaction(async (client) => {
      const predicates = [
        `d.state in ('pending', 'retry_wait')`,
        `d.next_attempt_at <= $1`,
        `e.delivery_eligibility = 'eligible'`,
        `s.status = 'active'`,
        `s.enabled`,
        `v.active`,
      ];
      const values: unknown[] = [new Date(input.now)];
      if (input.tenantId !== undefined) { values.push(input.tenantId); predicates.push(`d.tenant_id = $${values.length}`); }
      if (input.consumerId !== undefined) { values.push(input.consumerId); predicates.push(`d.consumer_id = $${values.length}`); }
      values.push(limit);
      const rows = await client.query<DbRow>(
        `select d.id::text as delivery_id
           from agent_feed.consumer_deliveries d
           join agent_feed.outbox_events e on e.tenant_id = d.tenant_id and e.event_id = d.event_id
           join agent_feed.consumer_subscriptions s
             on s.tenant_id = d.tenant_id and s.consumer_id = d.consumer_id and s.id = d.subscription_id
           join agent_feed.consumer_subscription_versions v
             on v.tenant_id = d.tenant_id and v.consumer_id = d.consumer_id
            and v.subscription_id = d.subscription_id and v.selector_version = d.selector_version
          where ${predicates.join(" and ")}
          order by e.delivery_position, e.event_id
          limit $${values.length}
          for update of d skip locked`, values,
      );
      const claims: DeliveryClaim[] = [];
      for (const row of rows.rows) {
        const deliveryId = text(row.delivery_id);
        const leaseToken = randomUUID();
        const now = new Date(input.now);
        const attempt = await client.query<{ attempt_count: number | string }>(
          `update agent_feed.consumer_deliveries
              set state = 'in_flight', attempt_count = attempt_count + 1,
                  lease_token = $2::uuid, lease_expires_at = $3,
                  lease_owner = $4, updated_at = now()
            where id = $1::uuid
            returning attempt_count`,
          [deliveryId, leaseToken, new Date(now.getTime() + leaseSeconds * 1000), input.workerId],
        );
        const attemptNumber = int(attempt.rows[0]?.attempt_count ?? 0);
        const replay = await client.query<{ replay_count: number | string }>(
          `select replay_count from agent_feed.consumer_deliveries where id = $1::uuid`, [deliveryId],
        );
        const kind = int(replay.rows[0]?.replay_count ?? 0) > 0 ? "replay" : attemptNumber === 1 ? "initial" : "retry";
        await client.query(
          `insert into agent_feed.delivery_attempts (
             tenant_id, consumer_id, delivery_id, attempt_number, attempt_kind,
             worker_id, request_timestamp
           ) select tenant_id, consumer_id, id, $2, $3, $4, $5
               from agent_feed.consumer_deliveries where id = $1::uuid`,
          [deliveryId, attemptNumber, kind, input.workerId, now],
        );
        const claim = await this.loadClaim(client, deliveryId);
        if (claim) claims.push(claim);
      }
      return claims;
    });
  }

  async acknowledge(input: AcknowledgeInput): Promise<LeaseTransitionResult> {
    return this.withTransaction(async (client) => {
      const row = await this.lockScopedDelivery(client, input);
      const invalid = this.validateLease(row, input);
      if (invalid) return invalid;
      const acknowledgementKey = `${input.deliveryId}:${input.attempt}:${input.replayGeneration}`;
      const hash = input.responseBodyHash ?? "";
      await client.query(
        `insert into agent_feed.acknowledgements (
           tenant_id, consumer_id, subscription_id, delivery_id, event_id,
           attempt_number, acknowledgement_key, acknowledgement_payload_hash,
           consumer_receipt
         ) select tenant_id, consumer_id, subscription_id, id, event_id,
                  $2, $3, $4, jsonb_build_object('status', $5::integer)
             from agent_feed.consumer_deliveries where id = $1::uuid
         on conflict (tenant_id, subscription_id, event_id) do nothing`,
        [input.deliveryId, input.attempt, acknowledgementKey, hash, input.status],
      );
      const existing = await client.query<{ acknowledgement_payload_hash: string }>(
        `select acknowledgement_payload_hash
           from agent_feed.acknowledgements
          where tenant_id = $1 and subscription_id = $2::uuid and event_id = $3`,
        [input.tenantId, row?.subscription_id, row?.event_id],
      );
      if (existing.rows[0] && existing.rows[0].acknowledgement_payload_hash !== hash) {
        throw new Error("acknowledgement_conflict");
      }
      await client.query(
        `update agent_feed.consumer_deliveries
            set state = 'acknowledged', acknowledged_at = coalesce(acknowledged_at, $2),
                lease_token = null, lease_expires_at = null, lease_owner = null,
                updated_at = now()
          where id = $1::uuid`, [input.deliveryId, new Date(input.now)],
      );
      await client.query(
        `update agent_feed.delivery_attempts
            set state = 'succeeded', finished_at = $4, http_status = $5,
                response_hash = $6
          where tenant_id = $1 and consumer_id = $2 and delivery_id = $3::uuid
            and attempt_number = $7 and state = 'in_flight'`,
        [input.tenantId, input.consumerId, input.deliveryId, new Date(input.now), input.status, hash || null, input.attempt],
      );
      return { applied: true, job: await this.loadJob(client, input.deliveryId) };
    });
  }

  async scheduleRetry(input: RetryInput): Promise<LeaseTransitionResult> {
    return this.finishLease(input, "retry_wait");
  }

  async deadLetter(input: DeadLetterInput): Promise<LeaseTransitionResult> {
    return this.finishLease(input, "dead_letter");
  }

  private async finishLease(input: RetryInput | DeadLetterInput, target: "retry_wait" | "dead_letter"): Promise<LeaseTransitionResult> {
    return this.withTransaction(async (client) => {
      const row = await this.lockScopedDelivery(client, input);
      const invalid = this.validateLease(row, input);
      if (invalid) return invalid;
      const error = durableError(input.error);
      const next = target === "retry_wait" ? new Date((input as RetryInput).nextAttemptAt) : new Date(input.now);
      await client.query(
        `update agent_feed.delivery_attempts
            set state = $5, finished_at = $4, error_code = $6, error_detail = $7,
                response_hash = $8, http_status = $9
          where tenant_id = $1 and consumer_id = $2 and delivery_id = $3::uuid
            and attempt_number = $10 and state = 'in_flight'`,
        [input.tenantId, input.consumerId, input.deliveryId, new Date(input.now),
          target === "retry_wait" ? "failed" : "dead_lettered", error.code, error.message,
          error.responseBodyHash ?? null, error.status, input.attempt],
      );
      await client.query(
        `update agent_feed.consumer_deliveries
            set state = $2, next_attempt_at = $3, lease_token = null,
                lease_expires_at = null, lease_owner = null,
                dead_lettered_at = case when $2 = 'dead_letter' then $4 else dead_lettered_at end,
                dead_letter_reason = case when $2 = 'dead_letter' then $5 else dead_letter_reason end,
                last_error_code = $5, last_error_detail = $6, updated_at = now()
          where id = $1::uuid`,
        [input.deliveryId, target, next, new Date(input.now), error.code, error.message],
      );
      return { applied: true, job: await this.loadJob(client, input.deliveryId) };
    });
  }

  async recoverExpiredLeases(input: { now: string; limit: number }): Promise<number> {
    return this.withTransaction(async (client) => {
      const rows = await client.query<DbRow>(
        `select id::text as delivery_id, tenant_id, consumer_id, attempt_count
           from agent_feed.consumer_deliveries
          where state = 'in_flight' and lease_expires_at is not null and lease_expires_at <= $1
          order by lease_expires_at, id
          limit $2 for update skip locked`, [new Date(input.now), Math.min(Math.max(Math.trunc(input.limit), 1), 500)],
      );
      for (const row of rows.rows) {
        await client.query(
          `update agent_feed.consumer_deliveries
              set state = 'retry_wait', next_attempt_at = $2,
                  lease_token = null, lease_expires_at = null, lease_owner = null,
                  last_error_code = 'lease_expired', last_error_detail = 'delivery lease expired', updated_at = now()
            where id = $1::uuid`, [row.delivery_id, new Date(input.now)],
        );
        await client.query(
          `update agent_feed.delivery_attempts
              set state = 'expired', finished_at = $4,
                  error_code = 'lease_expired', error_detail = 'delivery lease expired'
            where tenant_id = $1 and consumer_id = $2 and delivery_id = $3::uuid
              and attempt_number = $5 and state = 'in_flight'`,
          [row.tenant_id, row.consumer_id, row.delivery_id, new Date(input.now), int(row.attempt_count)],
        );
      }
      return rows.rowCount ?? rows.rows.length;
    });
  }

  async replay(input: ReplayInput): Promise<DeliveryJob> {
    return this.withTransaction(async (client) => {
      const rows = await client.query<DbRow>(
        `select * from agent_feed.consumer_deliveries
          where tenant_id = $1 and consumer_id = $2 and subscription_id = $3::uuid and id = $4::uuid
          for update`, [input.tenantId, input.consumerId, input.subscriptionId, input.deliveryId],
      );
      const row = rows.rows[0];
      if (!row) throw new Error("delivery_not_found");
      const existing = await client.query<DbRow>(
        `select * from agent_feed.delivery_replays
          where tenant_id = $1 and consumer_id = $2 and delivery_id = $3::uuid and replay_idempotency_key = $4`,
        [input.tenantId, input.consumerId, input.deliveryId, input.idempotencyKey],
      );
      if (existing.rows[0]) {
        if (text(existing.rows[0].request_hash) !== input.payloadHash) throw new Error("replay_idempotency_conflict");
        return this.loadJob(client, input.deliveryId);
      }
      if (row.state !== "dead_letter") throw new Error("delivery_not_dead_lettered");
      const generation = int(row.replay_count) + 1;
      await client.query(
        `insert into agent_feed.delivery_replays (
           tenant_id, consumer_id, delivery_id, replay_idempotency_key,
           request_hash, requested_by, reason, replay_generation, requested_at
         ) values ($1, $2, $3::uuid, $4, $5, $6, $7, $8, $9)`,
        [input.tenantId, input.consumerId, input.deliveryId, input.idempotencyKey,
          input.payloadHash, input.requestedBy ?? input.consumerId, input.reason, generation, new Date(input.requestedAt)],
      );
      await client.query(
        `update agent_feed.consumer_deliveries
            set state = 'pending', replay_count = $2, next_attempt_at = $3,
                dead_lettered_at = null, dead_letter_reason = null,
                last_error_code = null, last_error_detail = null,
                updated_at = now()
          where id = $1::uuid`, [input.deliveryId, generation, new Date(input.requestedAt)],
      );
      return this.loadJob(client, input.deliveryId);
    });
  }

  async pull(input: PullInput): Promise<PullPage> {
    if (this.#cursorCodec === null) throw new Error("cursor_codec_required");
    const version = int(input.selectorVersion);
    const cursorClaims = input.cursor === null ? null : this.#cursorCodec.decode(input.cursor);
    if (cursorClaims !== null) {
      assertCursorScope(cursorClaims, {
        tenantId: input.tenantId,
        consumerId: input.consumerId,
        subscriptionId: input.subscriptionId,
        selectorVersion: version,
      });
    }
    const limit = Math.min(Math.max(Math.trunc(input.limit), 1), 500);
    const values: unknown[] = [input.tenantId, input.consumerId, input.subscriptionId, version, new Date(input.now)];
    const cursorSql = cursorClaims
      ? `and e.delivery_position > $6::bigint`
      : "";
    if (cursorClaims) values.push(cursorClaims.position);
    values.push(limit + 1);
    const rows = await this.pool.query<DbRow>(
      `select d.id::text as delivery_id, e.delivery_position::text as delivery_position, e.event_id
         from agent_feed.consumer_deliveries d
         join agent_feed.outbox_events e on e.tenant_id = d.tenant_id and e.event_id = d.event_id
        where d.tenant_id = $1 and d.consumer_id = $2 and d.subscription_id = $3::uuid
          and d.selector_version = $4 and d.state in ('pending', 'retry_wait')
          and d.next_attempt_at <= $5 and e.delivery_eligibility = 'eligible'
          ${cursorSql}
        order by e.delivery_position, e.event_id limit $${values.length}`,
      values,
    );
    const hasMore = rows.rows.length > limit;
    const selected = hasMore ? rows.rows.slice(0, limit) : rows.rows;
    const deliveries: DeliveryJob[] = [];
    for (const row of selected) {
      const claim = await this.loadClaim(this.pool, text(row.delivery_id));
      if (claim) deliveries.push({ ...claim.job, event: claim.event });
    }
    const last = selected[selected.length - 1];
    return {
      deliveries,
      nextCursor: hasMore && last ? this.#encodeCursor(input, version, text(last.delivery_position)) : null,
    };
  }

  #encodeCursor(input: PullInput, selectorVersion: number, position: string): string {
    const nowSeconds = this.#nowSeconds();
    if (!Number.isSafeInteger(nowSeconds) || nowSeconds < 0) throw new Error("cursor_clock_invalid");
    const claims: CursorPayload = {
      version: 1,
      tenantId: input.tenantId,
      consumerId: input.consumerId,
      subscriptionId: input.subscriptionId,
      selectorVersion,
      position,
      expiresAt: nowSeconds + this.#cursorTtlSeconds,
    };
    return this.#cursorCodec?.encode(claims) ?? (() => { throw new Error("cursor_codec_required"); })();
  }

  private async lockScopedDelivery(client: PoolClient, input: LeaseOutcomeInput): Promise<DbRow | null> {
    const rows = await client.query<DbRow>(
      `select * from agent_feed.consumer_deliveries
        where tenant_id = $1 and consumer_id = $2 and subscription_id = $3::uuid and id = $4::uuid
        for update`, [input.tenantId, input.consumerId, input.subscriptionId, input.deliveryId],
    );
    return rows.rows[0] ?? null;
  }

  private validateLease(row: DbRow | null, input: LeaseOutcomeInput): LeaseTransitionResult | null {
    if (!row) return { applied: false, reason: "not_found", job: null };
    if (row.state === "acknowledged" || row.state === "dead_letter") {
      return { applied: false, reason: "already_terminal", job: this.mapJob(row) };
    }
    const expires = date(row.lease_expires_at);
    if (row.state !== "in_flight" || text(row.lease_token ?? "") !== input.leaseToken
      || int(row.attempt_count) !== input.attempt || int(row.replay_count) !== input.replayGeneration
      || (expires !== null && new Date(expires).getTime() <= new Date(input.now).getTime())) {
      return { applied: false, reason: "stale_lease", job: this.mapJob(row) };
    }
    return null;
  }

  private mapJob(row: DbRow): DeliveryJob {
    return {
      deliveryId: text(row.id ?? row.delivery_id),
      tenantId: text(row.tenant_id),
      consumerId: text(row.consumer_id),
      subscriptionId: text(row.subscription_id),
      eventId: text(row.event_id),
      traceId: row.trace_id === null || row.trace_id === undefined ? null : text(row.trace_id),
      state: state(row.state),
      attempt: int(row.attempt_count),
      replayGeneration: int(row.replay_count),
      nextAttemptAt: requiredDate(row.next_attempt_at, "next_attempt_at"),
      leaseToken: row.lease_token === null || row.lease_token === undefined ? null : text(row.lease_token),
      leaseExpiresAt: date(row.lease_expires_at),
      acknowledgedAt: date(row.acknowledged_at),
      deadLetteredAt: date(row.dead_lettered_at),
      lastError: asError(row.last_error_code, row.last_error_detail, null, null),
    };
  }

  private async loadJob(client: PgPool | PoolClient, deliveryId: string): Promise<DeliveryJob> {
    const rows = await client.query<DbRow>(
      `select d.*, e.trace_id
         from agent_feed.consumer_deliveries d
         join agent_feed.outbox_events e on e.tenant_id = d.tenant_id and e.event_id = d.event_id
        where d.id = $1::uuid`, [deliveryId],
    );
    const row = rows.rows[0];
    if (!row) throw new Error("delivery_not_found");
    return this.mapJob(row);
  }

  private async loadClaim(client: PgPool | PoolClient, deliveryId: string): Promise<DeliveryClaim | null> {
    const rows = await client.query<DbRow>(
      `select d.*, e.protocol_version, e.event_type, e.stream_id, e.run_id,
              e.wire_finding_id, e.occurred_at, e.delivery_position,
              e.trace_id, e.payload, e.payload_hash, e.finding_type,
              e.routing_tags, e.delivery_eligibility,
              v.selector_version, v.active as version_active,
              v.include_run_events, v.delivery_mode, v.endpoint_url,
              v.signing_secret_ref, v.activation_position
         from agent_feed.consumer_deliveries d
         join agent_feed.outbox_events e on e.tenant_id = d.tenant_id and e.event_id = d.event_id
         join agent_feed.consumer_subscription_versions v
           on v.tenant_id = d.tenant_id and v.consumer_id = d.consumer_id
          and v.subscription_id = d.subscription_id and v.selector_version = d.selector_version
        where d.id = $1::uuid`, [deliveryId],
    );
    const row = rows.rows[0];
    if (!row) return null;
    const subscription = await this.loadSubscription(client, text(row.tenant_id), text(row.consumer_id), text(row.subscription_id), int(row.selector_version));
    return {
      job: this.mapJob(row),
      event: {
        protocolVersion: "0.1",
        eventId: text(row.event_id),
        eventType: asEventType(text(row.event_type)),
        tenantId: text(row.tenant_id),
        streamId: text(row.stream_id),
        runId: text(row.run_id),
        findingId: row.wire_finding_id === null || row.wire_finding_id === undefined ? null : text(row.wire_finding_id),
        occurredAt: requiredDate(row.occurred_at, "occurred_at"),
        sequence: text(row.delivery_position),
        traceId: row.trace_id === null || row.trace_id === undefined ? null : text(row.trace_id),
        payload: asObject(row.payload) as DeliveryEvent["payload"],
        payloadHash: text(row.payload_hash),
        findingType: row.finding_type === null || row.finding_type === undefined ? null : text(row.finding_type),
        routingTags: asStringArray(row.routing_tags),
        deliveryEligible: row.delivery_eligibility === "eligible",
      },
      subscription,
    };
  }

  private async loadSubscription(
    client: PgPool | PoolClient,
    tenantId: string,
    consumerId: string,
    subscriptionId: string,
    selectorVersion: number,
  ): Promise<ConsumerSubscription> {
    const versions = await client.query<DbRow>(
      `select * from agent_feed.consumer_subscription_versions
        where tenant_id = $1 and consumer_id = $2 and subscription_id = $3::uuid and selector_version = $4`,
      [tenantId, consumerId, subscriptionId, selectorVersion],
    );
    const version = versions.rows[0];
    if (!version) throw new Error("subscription_version_not_found");
    const selectors = await client.query<DbRow>(
      `select selector_kind, selector_value, match_mode
         from agent_feed.consumer_subscription_selectors
        where tenant_id = $1 and consumer_id = $2 and subscription_id = $3::uuid and selector_version = $4
        order by selector_kind, selector_value`, [tenantId, consumerId, subscriptionId, selectorVersion],
    );
    const streamIds: string[] = [];
    const findingTypes: string[] = [];
    const eventTypes: DeliveryEventType[] = [];
    const routingValues: string[] = [];
    let routingMode: "any" | "all" = "any";
    for (const selector of selectors.rows) {
      const kind = text(selector.selector_kind);
      const value = text(selector.selector_value);
      if (kind === "stream_id") streamIds.push(value);
      else if (kind === "finding_type") findingTypes.push(value);
      else if (kind === "event_type") eventTypes.push(asEventType(value));
      else if (kind === "routing_tag") { routingValues.push(value); routingMode = selector.match_mode === "all" ? "all" : routingMode; }
    }
    return {
      tenantId,
      consumerId,
      subscriptionId,
      selectorVersion,
      selectors: {
        streamIds,
        findingTypes: findingTypes.length > 0 ? findingTypes : null,
        routingTags: routingValues.length > 0 ? { mode: routingMode, values: routingValues } : null,
        eventTypes,
      },
      activationPosition: text(version.activation_position ?? "0"),
      status: status(version.active),
      endpoint: version.delivery_mode === "webhook"
        ? { endpointRef: text(version.endpoint_url), signingKeyId: text(version.signing_secret_ref) }
        : null,
    };
  }

  private async withTransaction<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const result = await operation(client);
      await client.query("commit");
      return result;
    } catch (error) {
      try { await client.query("rollback"); } catch { /* preserve original */ }
      throw error;
    } finally {
      client.release();
    }
  }
}

export type {
  AcknowledgeInput,
  ConsumerSubscription,
  DeadLetterInput,
  DeliveryClaim,
  DeliveryEndpoint,
  DeliveryError,
  DeliveryEvent,
  DeliveryEventType,
  DeliveryJob,
  LeaseClaimInput,
  LeaseOutcomeInput,
  LeaseTransitionResult,
  PullInput,
  PullPage,
  ReplayInput,
  RetryInput,
  SubscriptionInput,
  SubscriptionSelectors,
};
