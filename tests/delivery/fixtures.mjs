/**
 * Deterministic, domain-neutral fixtures for the Milestone 2 acceptance
 * tests. These fixtures intentionally do not import delivery implementation
 * code. A worker test can adapt them to its public service boundary.
 */

export const FIXTURE_CLOCK = Object.freeze({
  nowIso: "2026-08-18T00:00:00.000Z",
  nowSeconds: 1_787_011_200,
});

export const TENANTS = Object.freeze({
  A: Object.freeze({ tenantId: "tenant_a", name: "Tenant A" }),
  B: Object.freeze({ tenantId: "tenant_b", name: "Tenant B" }),
});

export const CONSUMERS = Object.freeze({
  A: Object.freeze({ consumerId: "consumer_a", tenantId: TENANTS.A.tenantId, streamId: "shared.monitor" }),
  B: Object.freeze({ consumerId: "consumer_b", tenantId: TENANTS.B.tenantId, streamId: "shared.monitor" }),
});

export const FAILURE_MODES = Object.freeze({
  healthy: Object.freeze([{ kind: "response", status: 204 }]),
  unavailable: Object.freeze([
    { kind: "response", status: 503 },
    { kind: "response", status: 503 },
    { kind: "response", status: 204 },
  ]),
  timeout: Object.freeze([{ kind: "timeout" }]),
  rateLimited: Object.freeze([{ kind: "response", status: 429, retryAfterSeconds: 30 }]),
  permanentFailure: Object.freeze([{ kind: "response", status: 400 }]),
  crashAfterReceipt: Object.freeze([{ kind: "crash_after_receipt" }]),
  invalidSignature: Object.freeze([{ kind: "response", status: 401 }]),
});

function event(tenantId, consumerId, suffix, findingType, routingTags) {
  return {
    tenantId,
    consumerId,
    eventId: `evt_${tenantId}_${suffix}`,
    streamId: "shared.monitor",
    runId: `run_${tenantId}_001`,
    findingId: suffix === "terminal" ? null : `finding_${tenantId}_001`,
    eventType: suffix === "terminal" ? "run.completed" : "finding.submitted",
    findingType,
    routingTags: [...routingTags],
    occurredAt: "2026-08-17T23:59:00.000Z",
    attempt: 1,
    traceId: `trace_${tenantId}_001`,
    payload: { synthetic: true, tenantId },
  };
}

/**
 * Includes the same stream name in both tenants. Implementations must scope
 * every lookup by tenant/subscription rather than relying on stream names or
 * globally unique fixture IDs.
 */
export function twoTenantDeliveryFixture() {
  return structuredClone({
    tenants: [TENANTS.A, TENANTS.B],
    consumers: [CONSUMERS.A, CONSUMERS.B],
    subscriptions: [
      {
        subscriptionId: "subscription_a",
        tenantId: TENANTS.A.tenantId,
        consumerId: CONSUMERS.A.consumerId,
        streamIds: ["shared.monitor"],
        findingTypes: ["monitor.change"],
        routingTags: ["important"],
      },
      {
        subscriptionId: "subscription_b",
        tenantId: TENANTS.B.tenantId,
        consumerId: CONSUMERS.B.consumerId,
        streamIds: ["shared.monitor"],
        findingTypes: ["monitor.change"],
        routingTags: ["important"],
      },
    ],
    events: [
      event(TENANTS.A.tenantId, CONSUMERS.A.consumerId, "finding", "monitor.change", ["important"]),
      event(TENANTS.A.tenantId, CONSUMERS.A.consumerId, "terminal", "", []),
      event(TENANTS.B.tenantId, CONSUMERS.B.consumerId, "finding", "monitor.change", ["important"]),
      event(TENANTS.B.tenantId, CONSUMERS.B.consumerId, "terminal", "", []),
    ],
  });
}

/**
 * Returns a fresh sequence for a deterministic fake webhook. A worker test
 * consumes one entry per attempt and may repeat the last entry after the
 * sequence is exhausted.
 */
export function failureSequence(mode) {
  const sequence = FAILURE_MODES[mode];
  if (!sequence) throw new Error(`unknown_failure_mode:${mode}`);
  return structuredClone(sequence);
}
