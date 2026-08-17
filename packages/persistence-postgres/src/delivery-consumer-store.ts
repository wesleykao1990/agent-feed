import { randomUUID } from "node:crypto";
import type { PoolClient, QueryResultRow } from "pg";
import {
  DELIVERY_EVENT_TYPES,
  DeliveryConsumerRepositoryError,
  type AcknowledgeRecord,
  type AcknowledgeRepositoryResult,
  type ConsumerScope,
  type CreateSubscriptionRecord,
  type DeadLetterQuery,
  type DeadLetterRecord,
  type DeliveryConsumerRepository,
  type DeliveryEventRecord,
  type DeliveryEventType,
  type DeliveryConfiguration,
  type NormalizedSubscriptionSelector,
  type PullPageQuery,
  type PullPageRepositoryResult,
  type ReplayDeadLetterRecord,
  type ReplayRepositoryResult,
  type SubscriptionDeliveryRecord,
  type SubscriptionRecord,
  type UpdateSubscriptionRecord,
} from "@agent-feed/delivery-consumer";
import type { PgPool } from "./types.ts";

type DbRow = QueryResultRow & Record<string, unknown>;

const ALL_EVENT_TYPES = [...DELIVERY_EVENT_TYPES];

function asText(value: unknown): string {
  return String(value);
}

function asInt(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`invalid database integer: ${String(value)}`);
  return parsed;
}

function asDate(value: unknown): string {
  if (value === null || value === undefined) throw new Error("database returned a null timestamp");
  return value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();
}

function asNullableDate(value: unknown): string | null {
  return value === null || value === undefined ? null : asDate(value);
}

function asObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  return {};
}

function asStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function asEventType(value: unknown): DeliveryEventType {
  if (typeof value === "string" && ALL_EVENT_TYPES.includes(value as DeliveryEventType)) {
    return value as DeliveryEventType;
  }
  throw new Error(`invalid delivery event type: ${String(value)}`);
}

function asStatus(value: unknown): SubscriptionRecord["status"] {
  if (value === "active" || value === "paused" || value === "revoked") return value;
  throw new Error(`invalid subscription status: ${String(value)}`);
}

function asDeliveryMode(value: unknown): DeliveryConfiguration["mode"] {
  if (value === "pull" || value === "webhook") return value;
  throw new Error(`invalid delivery mode: ${String(value)}`);
}

function asPosition(value: unknown): string {
  const result = asText(value);
  if (!/^(0|[1-9][0-9]*)$/u.test(result)) throw new Error(`invalid delivery position: ${result}`);
  return result;
}

function json(value: unknown): string {
  return JSON.stringify(value);
}

function repositoryError(error: unknown): DeliveryConsumerRepositoryError {
  if (error instanceof DeliveryConsumerRepositoryError) return error;
  const candidate = error as { code?: unknown; constraint?: unknown } | null;
  const code = candidate && typeof candidate === "object" ? String(candidate.code ?? "") : "";
  if (code === "22P02") return new DeliveryConsumerRepositoryError("not_found", "the requested identifier is not valid");
  if (code === "23503") return new DeliveryConsumerRepositoryError("not_found", "the requested resource was not found");
  if (code === "23505") return new DeliveryConsumerRepositoryError("subscription_conflict", "subscription uniqueness conflict");
  if (code === "23514" || code === "23502") {
    return new DeliveryConsumerRepositoryError("invalid_state", "the database rejected the delivery state");
  }
  return new DeliveryConsumerRepositoryError("invalid_state", "delivery database operation failed");
}

function storedAcknowledgement(value: unknown): AcknowledgeRepositoryResult {
  const object = asObject(value);
  const acknowledgementId = object.acknowledgementId;
  const ids = object.acknowledgedDeliveryIds;
  const ackPosition = object.ackPosition;
  if (typeof acknowledgementId !== "string" || !Array.isArray(ids)
    || ids.some((entry) => typeof entry !== "string")
    || (ackPosition !== null && typeof ackPosition !== "string")) {
    throw new Error("invalid acknowledgement command result");
  }
  return {
    acknowledgementId,
    acknowledgedDeliveryIds: [...ids] as string[],
    ackPosition: ackPosition as string | null,
  };
}

function requireWebhookConfiguration(delivery: DeliveryConfiguration): void {
  if (delivery.mode === "webhook" && (!delivery.endpointRef || !delivery.signingKeyId)) {
    throw new DeliveryConsumerRepositoryError(
      "invalid_state",
      "webhook subscriptions require endpointRef and signingKeyId",
    );
  }
  if (delivery.mode === "pull" && (delivery.endpointRef !== null || delivery.signingKeyId !== null)) {
    throw new DeliveryConsumerRepositoryError(
      "invalid_state",
      "pull subscriptions cannot contain webhook configuration",
    );
  }
}

/**
 * PostgreSQL implementation of the consumer-facing repository port.
 *
 * This adapter consumes already-normalized selector versions and already
 * materialized delivery rows. Selector matching and signed cursor framing
 * remain owned by delivery-core/delivery-consumer; SQL only applies the
 * subscription/version and tenant scope supplied by the service.
 */
export class PostgresDeliveryConsumerRepository implements DeliveryConsumerRepository {
  readonly pool: PgPool;

  constructor(pool: PgPool) {
    this.pool = pool;
  }

  async createSubscription(input: CreateSubscriptionRecord): Promise<SubscriptionRecord> {
    requireWebhookConfiguration(input.delivery);
    return this.withTransaction(async (client) => {
      const subscriptionId = randomUUID();
      const activationPosition = await this.lockTenantPosition(client, input.scope.tenantId);
      await client.query(
        `insert into agent_feed.consumer_subscriptions (
           id, tenant_id, consumer_id, name, status, selector_hash,
           stream_id, finding_type, routing_tag, selector_version,
           delivery_mode, endpoint_url, signing_secret_ref, enabled,
           starts_at, include_run_events, event_types, routing_tag_match
         ) values ($1, $2, $3, $4, 'active', $5, $6, $7, $8, 1,
                   $9, $10, $11, true, now(), true, $12::jsonb, $13)`,
        [
          subscriptionId,
          input.scope.tenantId,
          input.scope.consumerId,
          input.name,
          input.selectorHash,
          input.selectors.streamIds[0],
          input.selectors.findingTypes?.[0] ?? null,
          input.selectors.routingTags?.values[0] ?? null,
          input.delivery.mode,
          input.delivery.endpointRef,
          input.delivery.signingKeyId,
          json(input.selectors.eventTypes),
          input.selectors.routingTags?.mode ?? "any",
        ],
      );
      await this.insertVersion(client, {
        scope: input.scope,
        subscriptionId,
        selectorVersion: 1,
        selectorHash: input.selectorHash,
        selectors: input.selectors,
        delivery: input.delivery,
        activationPosition,
        active: true,
      });
      const result = await this.loadSubscription(client, input.scope, subscriptionId);
      if (!result) throw new DeliveryConsumerRepositoryError("invalid_state", "subscription disappeared after creation");
      return result;
    });
  }

  async getSubscription(scope: ConsumerScope, subscriptionId: string): Promise<SubscriptionRecord | null> {
    try {
      return await this.loadSubscription(this.pool, scope, subscriptionId);
    } catch (error) {
      throw repositoryError(error);
    }
  }

  async listSubscriptions(scope: ConsumerScope): Promise<SubscriptionRecord[]> {
    try {
      const rows = await this.pool.query<{ id: string }>(
        `select id::text as id
           from agent_feed.consumer_subscriptions
          where tenant_id = $1 and consumer_id = $2
          order by created_at, id`, [scope.tenantId, scope.consumerId],
      );
      const records: SubscriptionRecord[] = [];
      for (const row of rows.rows) {
        const record = await this.loadSubscription(this.pool, scope, row.id);
        if (record) records.push(record);
      }
      return records;
    } catch (error) {
      throw repositoryError(error);
    }
  }

  async updateSubscription(input: UpdateSubscriptionRecord): Promise<SubscriptionRecord | null> {
    if (input.activation !== "future" && input.activation !== "unchanged") {
      throw new DeliveryConsumerRepositoryError("invalid_state", "unsupported subscription activation policy");
    }
    if (input.delivery) requireWebhookConfiguration(input.delivery);
    return this.withTransaction(async (client) => {
      const baseRows = await client.query<DbRow>(
        `select id::text as id, status, enabled
           from agent_feed.consumer_subscriptions
          where tenant_id = $1 and consumer_id = $2 and id = $3::uuid
          for update`,
        [input.scope.tenantId, input.scope.consumerId, input.subscriptionId],
      );
      if (!baseRows.rows[0]) return null;
      const current = await this.loadSubscription(client, input.scope, input.subscriptionId);
      if (!current) return null;
      if (current.selectorVersion !== input.expectedSelectorVersion) {
        throw new DeliveryConsumerRepositoryError("subscription_conflict", "selector_version_conflict");
      }

      const nextStatus = input.status ?? current.status;
      const nextDelivery = input.delivery ?? current.delivery;
      const nextName = input.name ?? current.name;

      if (input.selectors !== undefined) {
        if (input.activation !== "future" || !input.selectorHash) {
          throw new DeliveryConsumerRepositoryError("invalid_state", "selector changes require a future activation hash");
        }
        const activationPosition = await this.lockTenantPosition(client, input.scope.tenantId);
        const nextVersion = current.selectorVersion + 1;
        await client.query(
          `update agent_feed.consumer_subscription_versions
              set active = false, active_until = coalesce(active_until, now()), updated_at = now()
            where tenant_id = $1 and consumer_id = $2 and subscription_id = $3::uuid and active`,
          [input.scope.tenantId, input.scope.consumerId, input.subscriptionId],
        );
        await this.insertVersion(client, {
          scope: input.scope,
          subscriptionId: input.subscriptionId,
          selectorVersion: nextVersion,
          selectorHash: input.selectorHash,
          selectors: input.selectors,
          delivery: nextDelivery,
          activationPosition,
          active: nextStatus === "active",
        });
        await client.query(
          `update agent_feed.consumer_subscriptions
              set name = $4, status = $5, selector_hash = $6,
                  enabled = $7, delivery_mode = $8, endpoint_url = $9,
                  signing_secret_ref = $10, updated_at = now(), selector_updated_at = now()
            where tenant_id = $1 and consumer_id = $2 and id = $3::uuid`,
          [input.scope.tenantId, input.scope.consumerId, input.subscriptionId, nextName,
            nextStatus, input.selectorHash, nextStatus === "active", nextDelivery.mode,
            nextDelivery.endpointRef, nextDelivery.signingKeyId],
        );
      } else {
        await client.query(
          `update agent_feed.consumer_subscriptions
              set name = $4, status = $5, enabled = $6,
                  delivery_mode = $7, endpoint_url = $8,
                  signing_secret_ref = $9, updated_at = now()
            where tenant_id = $1 and consumer_id = $2 and id = $3::uuid`,
          [input.scope.tenantId, input.scope.consumerId, input.subscriptionId, nextName,
            nextStatus, nextStatus === "active", nextDelivery.mode,
            nextDelivery.endpointRef, nextDelivery.signingKeyId],
        );
        await client.query(
          `update agent_feed.consumer_subscription_versions
              set active = $5,
                  active_until = case when $5 then null else coalesce(active_until, now()) end,
                  delivery_mode = $6, endpoint_url = $7,
                  signing_secret_ref = $8, updated_at = now()
            where tenant_id = $1 and consumer_id = $2 and subscription_id = $3::uuid
              and selector_version = $4`,
          [input.scope.tenantId, input.scope.consumerId, input.subscriptionId,
            current.selectorVersion, nextStatus === "active", nextDelivery.mode,
            nextDelivery.endpointRef, nextDelivery.signingKeyId],
        );
      }
      const updated = await this.loadSubscription(client, input.scope, input.subscriptionId);
      if (!updated) throw new DeliveryConsumerRepositoryError("invalid_state", "subscription disappeared after update");
      return updated;
    });
  }

  async pullPage(input: PullPageQuery): Promise<PullPageRepositoryResult> {
    if (!/^(0|[1-9][0-9]*)$/u.test(input.afterPosition)) {
      throw new DeliveryConsumerRepositoryError("invalid_state", "afterPosition must be a decimal position");
    }
    const limit = Math.min(Math.max(Math.trunc(input.limit), 1), 500);
    try {
      const subscription = await this.loadSubscription(this.pool, input.scope, input.subscriptionId);
      if (!subscription) throw new DeliveryConsumerRepositoryError("not_found");
      if (subscription.selectorVersion !== input.selectorVersion) {
        throw new DeliveryConsumerRepositoryError("subscription_conflict", "selector_version_conflict");
      }
      if (subscription.status !== "active") {
        return { items: [], nextPosition: input.afterPosition, hasMore: false, ackPosition: null };
      }
      const rows = await this.pool.query<DbRow>(
        `select d.id::text as delivery_id, d.state, d.attempt_count,
                d.next_attempt_at, d.last_error_code, d.last_error_detail,
                e.event_id, e.event_type, e.stream_id, e.run_id::text as run_id,
                coalesce(e.wire_finding_id, e.finding_id::text) as finding_id,
                e.occurred_at, e.payload, e.finding_type, e.routing_tags,
                e.delivery_position::text as delivery_position, e.trace_id
           from agent_feed.consumer_deliveries d
           join agent_feed.outbox_events e
             on e.tenant_id = d.tenant_id and e.event_id = d.event_id
           join agent_feed.consumer_subscriptions s
             on s.tenant_id = d.tenant_id and s.consumer_id = d.consumer_id
            and s.id = d.subscription_id and s.status = 'active' and s.enabled
          where d.tenant_id = $1 and d.consumer_id = $2 and d.subscription_id = $3::uuid
            and d.state in ('pending', 'retry_wait')
            and e.delivery_eligibility = 'eligible'
            and e.delivery_position > $4::bigint
          order by e.delivery_position, e.event_id
          limit $5`,
        [input.scope.tenantId, input.scope.consumerId, input.subscriptionId,
          input.afterPosition, limit + 1],
      );
      const hasMore = rows.rows.length > limit;
      const selected = hasMore ? rows.rows.slice(0, limit) : rows.rows;
      const items = selected.map((row) => this.mapDelivery(row, input.subscriptionId));
      const nextPosition = selected.length === 0
        ? input.afterPosition
        : asPosition(selected[selected.length - 1]?.delivery_position);
      return {
        items,
        nextPosition,
        hasMore,
        ackPosition: await this.loadContiguousAckPosition(this.pool, input.scope, input.subscriptionId),
      };
    } catch (error) {
      throw repositoryError(error);
    }
  }

  async acknowledge(input: AcknowledgeRecord): Promise<AcknowledgeRepositoryResult> {
    if (input.ackThroughPosition !== null && !/^(0|[1-9][0-9]*)$/u.test(input.ackThroughPosition)) {
      throw new DeliveryConsumerRepositoryError("invalid_state", "ackThroughPosition must be a decimal position");
    }
    return this.withTransaction(async (client) => {
      const subscriptionRows = await client.query<DbRow>(
        `select s.status, s.enabled, v.delivery_mode
           from agent_feed.consumer_subscriptions s
           join lateral (
             select delivery_mode
               from agent_feed.consumer_subscription_versions v
              where v.tenant_id = s.tenant_id and v.consumer_id = s.consumer_id
                and v.subscription_id = s.id
              order by v.selector_version desc limit 1
           ) v on true
          where s.tenant_id = $1 and s.consumer_id = $2 and s.id = $3::uuid
          for update of s`,
        [input.scope.tenantId, input.scope.consumerId, input.subscriptionId],
      );
      const subscription = subscriptionRows.rows[0];
      if (!subscription) throw new DeliveryConsumerRepositoryError("not_found");
      if (subscription.status !== "active" || subscription.enabled !== true) {
        throw new DeliveryConsumerRepositoryError("invalid_state", "subscription is not active");
      }
      if (subscription.delivery_mode !== "pull") {
        throw new DeliveryConsumerRepositoryError("invalid_state", "webhook deliveries require a lease acknowledgement");
      }

      const existing = await client.query<DbRow>(
        `select id::text as id, payload_hash, result
           from agent_feed.acknowledgement_commands
          where tenant_id = $1 and consumer_id = $2 and subscription_id = $3::uuid
            and idempotency_key = $4
          for update`,
        [input.scope.tenantId, input.scope.consumerId, input.subscriptionId, input.idempotencyKey],
      );
      if (existing.rows[0]) {
        if (asText(existing.rows[0].payload_hash) !== input.payloadHash) {
          throw new DeliveryConsumerRepositoryError("idempotency_payload_conflict");
        }
        return storedAcknowledgement(existing.rows[0].result);
      }

      const rows = await client.query<DbRow>(
        `select d.id::text as delivery_id, d.state, d.attempt_count,
                e.event_id, e.delivery_position::text as delivery_position
           from agent_feed.consumer_deliveries d
           join agent_feed.outbox_events e
             on e.tenant_id = d.tenant_id and e.event_id = d.event_id
          where d.tenant_id = $1 and d.consumer_id = $2 and d.subscription_id = $3::uuid
            and (d.id = any($4::uuid[])
              or ($5::bigint is not null and e.delivery_position <= $5::bigint))
          order by e.delivery_position, d.id`,
        [input.scope.tenantId, input.scope.consumerId, input.subscriptionId,
          input.deliveryIds, input.ackThroughPosition],
      );
      const requested = new Set(input.deliveryIds);
      const found = new Set(rows.rows.map((row) => asText(row.delivery_id)));
      for (const deliveryId of requested) {
        if (!found.has(deliveryId)) throw new DeliveryConsumerRepositoryError("not_found", `delivery ${deliveryId} was not found`);
      }

      const acknowledgementId = randomUUID();
      const acknowledgedDeliveryIds: string[] = [];
      for (const row of rows.rows) {
        const deliveryId = asText(row.delivery_id);
        const rowState = asText(row.state);
        if (rowState === "acknowledged") {
          acknowledgedDeliveryIds.push(deliveryId);
          continue;
        }
        if (rowState !== "pending" && rowState !== "retry_wait") {
          throw new DeliveryConsumerRepositoryError("invalid_state", `delivery ${deliveryId} is ${rowState}`);
        }
        await client.query(
          `update agent_feed.consumer_deliveries
              set state = 'acknowledged', acknowledged_at = coalesce(acknowledged_at, now()),
                  lease_token = null, lease_expires_at = null, lease_owner = null,
                  updated_at = now()
            where tenant_id = $1 and consumer_id = $2 and id = $3::uuid`,
          [input.scope.tenantId, input.scope.consumerId, deliveryId],
        );
        const attemptNumber = Math.max(1, asInt(row.attempt_count));
        await client.query(
          `insert into agent_feed.acknowledgements (
             tenant_id, consumer_id, subscription_id, delivery_id, event_id,
             attempt_number, acknowledgement_key, acknowledgement_payload_hash,
             consumer_receipt
           ) values ($1, $2, $3::uuid, $4::uuid, $5, $6, $7, $8, $9::jsonb)
           on conflict (tenant_id, subscription_id, event_id) do nothing`,
          [input.scope.tenantId, input.scope.consumerId, input.subscriptionId, deliveryId,
            row.event_id, attemptNumber, `${input.idempotencyKey}:${deliveryId}`,
            input.payloadHash, json({ acknowledgementId, idempotencyKey: input.idempotencyKey })],
        );
        acknowledgedDeliveryIds.push(deliveryId);
      }
      acknowledgedDeliveryIds.sort((left, right) => left.localeCompare(right));
      const result: AcknowledgeRepositoryResult = {
        acknowledgementId,
        acknowledgedDeliveryIds,
        ackPosition: await this.loadContiguousAckPosition(client, input.scope, input.subscriptionId),
      };
      const inserted = await client.query<{ id: string }>(
        `insert into agent_feed.acknowledgement_commands (
           tenant_id, consumer_id, subscription_id, idempotency_key,
           payload_hash, acknowledgement_id, result
         ) values ($1, $2, $3::uuid, $4, $5, $6::uuid, $7::jsonb)
         on conflict (tenant_id, consumer_id, subscription_id, idempotency_key) do nothing
         returning id::text as id`,
        [input.scope.tenantId, input.scope.consumerId, input.subscriptionId,
          input.idempotencyKey, input.payloadHash, acknowledgementId, json(result)],
      );
      if (inserted.rows.length === 0) {
        const raced = await client.query<DbRow>(
          `select payload_hash, result
             from agent_feed.acknowledgement_commands
            where tenant_id = $1 and consumer_id = $2 and subscription_id = $3::uuid
              and idempotency_key = $4`,
          [input.scope.tenantId, input.scope.consumerId, input.subscriptionId, input.idempotencyKey],
        );
        if (!raced.rows[0]) throw new DeliveryConsumerRepositoryError("invalid_state", "acknowledgement command disappeared");
        if (asText(raced.rows[0].payload_hash) !== input.payloadHash) {
          throw new DeliveryConsumerRepositoryError("idempotency_payload_conflict");
        }
        return storedAcknowledgement(raced.rows[0].result);
      }
      return result;
    });
  }

  async listDeadLetters(input: DeadLetterQuery): Promise<DeadLetterRecord[]> {
    const limit = Math.min(Math.max(Math.trunc(input.limit), 1), 500);
    try {
      const subscription = await this.loadSubscription(this.pool, input.scope, input.subscriptionId);
      if (!subscription) throw new DeliveryConsumerRepositoryError("not_found");
      const rows = await this.pool.query<DbRow>(
        `select d.id::text as delivery_id, d.state, d.attempt_count,
                d.next_attempt_at, d.last_error_code, d.last_error_detail,
                d.dead_lettered_at, e.event_id, e.event_type, e.stream_id,
                e.run_id::text as run_id,
                coalesce(e.wire_finding_id, e.finding_id::text) as finding_id,
                e.occurred_at, e.payload, e.finding_type, e.routing_tags,
                e.delivery_position::text as delivery_position, e.trace_id
           from agent_feed.consumer_deliveries d
           join agent_feed.outbox_events e
             on e.tenant_id = d.tenant_id and e.event_id = d.event_id
          where d.tenant_id = $1 and d.consumer_id = $2 and d.subscription_id = $3::uuid
            and d.state = 'dead_letter'
          order by e.delivery_position, d.id
          limit $4`,
        [input.scope.tenantId, input.scope.consumerId, input.subscriptionId, limit],
      );
      return rows.rows.map((row) => ({
        ...this.mapDelivery(row, input.subscriptionId),
        deadAt: asDate(row.dead_lettered_at),
      }));
    } catch (error) {
      throw repositoryError(error);
    }
  }

  async replayDeadLetter(input: ReplayDeadLetterRecord): Promise<ReplayRepositoryResult> {
    return this.withTransaction(async (client) => {
      const subscription = await this.loadSubscription(client, input.scope, input.subscriptionId);
      if (!subscription) throw new DeliveryConsumerRepositoryError("not_found");
      const rows = await client.query<DbRow>(
        `select d.id::text as delivery_id, d.state, d.replay_count
           from agent_feed.consumer_deliveries d
          where d.tenant_id = $1 and d.consumer_id = $2 and d.subscription_id = $3::uuid
            and d.id = $4::uuid
          for update`,
        [input.scope.tenantId, input.scope.consumerId, input.subscriptionId, input.deliveryId],
      );
      const row = rows.rows[0];
      if (!row) throw new DeliveryConsumerRepositoryError("not_found");

      const existing = await client.query<DbRow>(
        `select id::text as replay_id, request_hash
           from agent_feed.delivery_replays
          where tenant_id = $1 and consumer_id = $2 and delivery_id = $3::uuid
            and replay_idempotency_key = $4`,
        [input.scope.tenantId, input.scope.consumerId, input.deliveryId, input.idempotencyKey],
      );
      if (existing.rows[0]) {
        if (asText(existing.rows[0].request_hash) !== input.payloadHash) {
          throw new DeliveryConsumerRepositoryError("idempotency_payload_conflict");
        }
        const delivery = await this.loadDelivery(client, input.scope, input.subscriptionId, input.deliveryId);
        if (!delivery) throw new DeliveryConsumerRepositoryError("not_found");
        return { replayId: asText(existing.rows[0].replay_id), delivery };
      }
      if (row.state !== "dead_letter") {
        throw new DeliveryConsumerRepositoryError("invalid_state", "delivery is not dead-lettered");
      }
      const generation = asInt(row.replay_count) + 1;
      const replayId = randomUUID();
      await client.query(
        `insert into agent_feed.delivery_replays (
           id, tenant_id, consumer_id, delivery_id, replay_idempotency_key,
           request_hash, requested_by, reason, replay_generation
         ) values ($1, $2, $3, $4::uuid, $5, $6, $3, 'consumer_requested_replay', $7)`,
        [replayId, input.scope.tenantId, input.scope.consumerId, input.deliveryId,
          input.idempotencyKey, input.payloadHash, generation],
      );
      await client.query(
        `update agent_feed.consumer_deliveries
            set state = 'pending', replay_count = $5, next_attempt_at = now(),
                dead_lettered_at = null, dead_letter_reason = null,
                last_error_code = null, last_error_detail = null, updated_at = now()
          where tenant_id = $1 and consumer_id = $2 and subscription_id = $3::uuid
            and id = $4::uuid`,
        [input.scope.tenantId, input.scope.consumerId, input.subscriptionId, input.deliveryId, generation],
      );
      const delivery = await this.loadDelivery(client, input.scope, input.subscriptionId, input.deliveryId);
      if (!delivery) throw new DeliveryConsumerRepositoryError("invalid_state", "delivery disappeared after replay");
      return { replayId, delivery };
    });
  }

  private async lockTenantPosition(client: PoolClient, tenantId: string): Promise<string> {
    await client.query(
      `insert into agent_feed.tenant_event_counters (tenant_id, last_position)
       values ($1, 0) on conflict (tenant_id) do nothing`, [tenantId],
    );
    const rows = await client.query<{ last_position: string | number }>(
      `select last_position from agent_feed.tenant_event_counters
        where tenant_id = $1 for update`, [tenantId],
    );
    return asPosition(rows.rows[0]?.last_position ?? "0");
  }

  private async insertVersion(client: PoolClient, input: {
    scope: ConsumerScope;
    subscriptionId: string;
    selectorVersion: number;
    selectorHash: string;
    selectors: NormalizedSubscriptionSelector;
    delivery: DeliveryConfiguration;
    activationPosition: string;
    active: boolean;
  }): Promise<void> {
    await client.query(
      `insert into agent_feed.consumer_subscription_versions (
         tenant_id, consumer_id, subscription_id, selector_version,
         active_from, activation_position, selector_hash, include_run_events,
         active, delivery_mode, endpoint_url, signing_secret_ref
       ) values ($1, $2, $3::uuid, $4, now(), $5::bigint, $6, true,
                 $7, $8, $9, $10)`,
      [input.scope.tenantId, input.scope.consumerId, input.subscriptionId,
        input.selectorVersion, input.activationPosition, input.selectorHash,
        input.active, input.delivery.mode, input.delivery.endpointRef, input.delivery.signingKeyId],
    );
    const selectorRows: Array<[string, string, string]> = [];
    for (const value of input.selectors.streamIds) selectorRows.push(["stream_id", value, "any"]);
    for (const value of input.selectors.findingTypes ?? []) selectorRows.push(["finding_type", value, "any"]);
    for (const value of input.selectors.eventTypes) selectorRows.push(["event_type", value, "any"]);
    for (const value of input.selectors.routingTags?.values ?? []) {
      selectorRows.push(["routing_tag", value, input.selectors.routingTags?.mode ?? "any"]);
    }
    for (const [kind, value, mode] of selectorRows) {
      await client.query(
        `insert into agent_feed.consumer_subscription_selectors (
           tenant_id, consumer_id, subscription_id, selector_version,
           selector_kind, selector_value, match_mode
         ) values ($1, $2, $3::uuid, $4, $5, $6, $7)`,
        [input.scope.tenantId, input.scope.consumerId, input.subscriptionId,
          input.selectorVersion, kind, value, mode],
      );
    }
  }

  private async loadSubscription(
    client: PgPool | PoolClient,
    scope: ConsumerScope,
    subscriptionId: string,
  ): Promise<SubscriptionRecord | null> {
    const baseRows = await client.query<DbRow>(
      `select id::text as id, tenant_id, consumer_id, name, status,
              selector_hash, created_at, updated_at
         from agent_feed.consumer_subscriptions
        where tenant_id = $1 and consumer_id = $2 and id = $3::uuid`,
      [scope.tenantId, scope.consumerId, subscriptionId],
    );
    const base = baseRows.rows[0];
    if (!base) return null;
    const versions = await client.query<DbRow>(
      `select selector_version, activation_position, selector_hash,
              delivery_mode, endpoint_url, signing_secret_ref, updated_at
         from agent_feed.consumer_subscription_versions
        where tenant_id = $1 and consumer_id = $2 and subscription_id = $3::uuid
        order by selector_version desc limit 1`,
      [scope.tenantId, scope.consumerId, subscriptionId],
    );
    const version = versions.rows[0];
    if (!version) throw new DeliveryConsumerRepositoryError("invalid_state", "subscription has no selector version");
    const selectors = await client.query<DbRow>(
      `select selector_kind, selector_value, match_mode
         from agent_feed.consumer_subscription_selectors
        where tenant_id = $1 and consumer_id = $2 and subscription_id = $3::uuid
          and selector_version = $4
        order by selector_kind, selector_value`,
      [scope.tenantId, scope.consumerId, subscriptionId, asInt(version.selector_version)],
    );
    const streamIds: string[] = [];
    const findingTypes: string[] = [];
    const eventTypes: DeliveryEventType[] = [];
    const routingValues: string[] = [];
    let routingMode: "any" | "all" = "any";
    for (const row of selectors.rows) {
      const kind = asText(row.selector_kind);
      const value = asText(row.selector_value);
      if (kind === "stream_id") streamIds.push(value);
      else if (kind === "finding_type") findingTypes.push(value);
      else if (kind === "event_type") eventTypes.push(asEventType(value));
      else if (kind === "routing_tag") {
        routingValues.push(value);
        if (row.match_mode === "all") routingMode = "all";
      }
    }
    if (streamIds.length === 0) throw new DeliveryConsumerRepositoryError("invalid_state", "subscription has no stream selector");
    return {
      id: asText(base.id),
      tenantId: asText(base.tenant_id),
      consumerId: asText(base.consumer_id),
      name: asText(base.name),
      selectors: {
        streamIds,
        findingTypes: findingTypes.length === 0 ? null : findingTypes,
        routingTags: routingValues.length === 0 ? null : { mode: routingMode, values: routingValues },
        eventTypes: eventTypes.length === 0 ? [...ALL_EVENT_TYPES] : eventTypes,
      },
      selectorHash: asText(version.selector_hash || base.selector_hash),
      selectorVersion: asInt(version.selector_version),
      delivery: {
        mode: asDeliveryMode(version.delivery_mode),
        endpointRef: version.endpoint_url === null || version.endpoint_url === undefined ? null : asText(version.endpoint_url),
        signingKeyId: version.signing_secret_ref === null || version.signing_secret_ref === undefined ? null : asText(version.signing_secret_ref),
      },
      status: asStatus(base.status),
      activationPosition: asPosition(version.activation_position),
      createdAt: asDate(base.created_at),
      updatedAt: asDate(version.updated_at > base.updated_at ? version.updated_at : base.updated_at),
    };
  }

  private async loadDelivery(
    client: PgPool | PoolClient,
    scope: ConsumerScope,
    subscriptionId: string,
    deliveryId: string,
  ): Promise<SubscriptionDeliveryRecord | null> {
    const rows = await client.query<DbRow>(
      `select d.id::text as delivery_id, d.state, d.attempt_count,
              d.next_attempt_at, d.last_error_code, d.last_error_detail,
              e.event_id, e.event_type, e.stream_id, e.run_id::text as run_id,
              coalesce(e.wire_finding_id, e.finding_id::text) as finding_id,
              e.occurred_at, e.payload, e.finding_type, e.routing_tags,
              e.delivery_position::text as delivery_position, e.trace_id
         from agent_feed.consumer_deliveries d
         join agent_feed.outbox_events e
           on e.tenant_id = d.tenant_id and e.event_id = d.event_id
        where d.tenant_id = $1 and d.consumer_id = $2 and d.subscription_id = $3::uuid
          and d.id = $4::uuid`,
      [scope.tenantId, scope.consumerId, subscriptionId, deliveryId],
    );
    const row = rows.rows[0];
    return row ? this.mapDelivery(row, subscriptionId) : null;
  }

  /**
   * Return the highest delivery position with no earlier unacknowledged
   * delivery for this subscription.  Positions for old selector versions are
   * intentionally included: a selector update changes future fan-out only,
   * so the acknowledgement watermark must not jump across an older pending
   * row just because the current version no longer pulls it.
   */
  private async loadContiguousAckPosition(
    client: PgPool | PoolClient,
    scope: ConsumerScope,
    subscriptionId: string,
  ): Promise<string | null> {
    const rows = await client.query<{ delivery_position: string; state: string }>(
      `select e.delivery_position::text as delivery_position, d.state
         from agent_feed.consumer_deliveries d
         join agent_feed.outbox_events e
           on e.tenant_id = d.tenant_id and e.event_id = d.event_id
        where d.tenant_id = $1 and d.consumer_id = $2 and d.subscription_id = $3::uuid
        order by e.delivery_position, d.id`,
      [scope.tenantId, scope.consumerId, subscriptionId],
    );
    let result: string | null = null;
    for (const row of rows.rows) {
      if (row.state !== "acknowledged") break;
      result = asPosition(row.delivery_position);
    }
    return result;
  }

  private mapDelivery(row: DbRow, subscriptionId: string): SubscriptionDeliveryRecord {
    const rawState = asText(row.state);
    const status: SubscriptionDeliveryRecord["status"] = rawState === "in_flight"
      ? "leased"
      : rawState === "acknowledged"
        ? "acknowledged"
        : rawState === "dead_letter"
          ? "dead"
          : "pending";
    const errorCode = row.last_error_code === null || row.last_error_code === undefined ? null : asText(row.last_error_code);
    const errorDetail = row.last_error_detail === null || row.last_error_detail === undefined ? null : asText(row.last_error_detail);
    const event: DeliveryEventRecord = {
      eventId: asText(row.event_id),
      eventType: asEventType(row.event_type),
      streamId: asText(row.stream_id),
      runId: asText(row.run_id),
      findingId: row.finding_id === null || row.finding_id === undefined ? null : asText(row.finding_id),
      occurredAt: asDate(row.occurred_at),
      attempt: asInt(row.attempt_count),
      payload: asObject(row.payload),
      findingType: row.finding_type === null || row.finding_type === undefined ? null : asText(row.finding_type),
      routingTags: asStrings(row.routing_tags),
      position: asPosition(row.delivery_position),
      traceId: row.trace_id === null || row.trace_id === undefined ? null : asText(row.trace_id),
    };
    return {
      deliveryId: asText(row.delivery_id),
      subscriptionId,
      event,
      attemptCount: asInt(row.attempt_count),
      status,
      nextAttemptAt: asNullableDate(row.next_attempt_at),
      lastError: errorCode === null ? null : errorDetail ?? errorCode,
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
      try { await client.query("rollback"); } catch { /* preserve the original error */ }
      throw repositoryError(error);
    } finally {
      client.release();
    }
  }
}
