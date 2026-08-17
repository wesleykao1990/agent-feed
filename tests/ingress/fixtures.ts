import { randomUUID } from "node:crypto";

export const TEST_SECRET_A = "m1-ingress-secret-a";
export const TEST_SECRET_B = "m1-ingress-secret-b";

export const TENANT_A = "m1-ingress-tenant-a";
export const TENANT_B = "m1-ingress-tenant-b";
export const PRODUCER_A = "m1-ingress-producer-a";
export const PRODUCER_B = "m1-ingress-producer-b";
export const STREAM_A = "m1.ingress.stream-a";
export const STREAM_B = "m1.ingress.stream-b";

export function fixtureId(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll("-", "")}`;
}

export function beginPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    protocol_version: "0.1",
    idempotency_key: fixtureId("begin"),
    stream_id: STREAM_A,
    producer: {
      producer_id: PRODUCER_A,
      type: "automation",
      name: "m1-live-ingress",
      version: "1",
    },
    task: {
      task_type: "m1-live-ingress",
      definition_id: null,
      definition_version: null,
    },
    expected_scope: {
      source_ids: ["source-a"],
      subjects: ["subject-a"],
      queries: [],
      metadata: {},
    },
    started_at: "2026-08-18T00:00:00.000Z",
    parent_run_id: null,
    metadata: {},
    ...overrides,
  };
}

export function evidencePayload(id = fixtureId("evidence"), overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    evidence_id: id,
    kind: "api",
    source: {
      uri: "https://example.invalid/source-a",
      title: "Source A",
      publisher: "Example",
      source_id: "source-a",
    },
    captured_at: "2026-08-18T00:00:01.000Z",
    published_at: null,
    locator: { type: "url", value: "https://example.invalid/source-a", page: null },
    excerpt: "A bounded, non-sensitive observation.",
    content_hash: null,
    artifact: { uri: null, media_type: null, size_bytes: null },
    handling: {
      contains_personal_data: false,
      contains_secrets: false,
      redistribution_restricted: false,
    },
    metadata: {},
    ...overrides,
  };
}

export function findingPayload(
  id = fixtureId("finding"),
  evidenceRefs: string[] = [],
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    finding_id: id,
    finding_type: "monitor.change",
    title: "A bounded finding",
    summary: "A bounded, non-sensitive observation for live ingress conformance.",
    subjects: [{ type: "subject", id: "subject-a", name: "Subject A" }],
    effective_time: {
      occurred_at: "2026-08-18T00:00:01.000Z",
      effective_from: null,
      effective_to: null,
    },
    assessment: {
      novelty: "new",
      source_authority_claim: "official_secondary",
      evidence_completeness: "complete",
      agent_confidence: 0.8,
    },
    evidence_refs: evidenceRefs,
    producer_dedupe_key: null,
    routing_tags: [],
    attributes: {},
    security_flags: [],
    ...overrides,
  };
}

export function batchPayload(
  runId: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const evidence = evidencePayload();
  const finding = findingPayload(undefined, [evidence.evidence_id as string]);
  return {
    protocol_version: "0.1",
    run_id: runId,
    batch_id: fixtureId("batch"),
    idempotency_key: fixtureId("batch-key"),
    sequence_number: 1,
    submitted_at: "2026-08-18T00:00:01.000Z",
    findings: [finding],
    evidence: [evidence],
    metadata: {},
    ...overrides,
  };
}

export function completePayload(runId: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    protocol_version: "0.1",
    run_id: runId,
    idempotency_key: fixtureId("complete"),
    status: "completed",
    completed_at: "2026-08-18T00:00:02.000Z",
    actual_scope: {
      source_ids: ["source-a"],
      subjects: ["subject-a"],
      queries: [],
      metadata: {},
    },
    stats: {
      sources_attempted: 1,
      sources_succeeded: 1,
      findings_submitted: 1,
      evidence_submitted: 1,
      batches_submitted: 1,
    },
    errors: [],
    metadata: {},
    ...overrides,
  };
}

export function completeZeroPayload(runId: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...completePayload(runId),
    idempotency_key: fixtureId("complete-zero"),
    actual_scope: {
      source_ids: [],
      subjects: [],
      queries: [],
      metadata: {},
    },
    stats: {
      sources_attempted: 0,
      sources_succeeded: 0,
      findings_submitted: 0,
      evidence_submitted: 0,
      batches_submitted: 0,
    },
    ...overrides,
  };
}

export function credentialA(): Record<string, unknown> {
  return {
    producerId: PRODUCER_A,
    producer_id: PRODUCER_A,
    tenantId: TENANT_A,
    tenant_id: TENANT_A,
    secret: TEST_SECRET_A,
    allowedStreamIds: [STREAM_A],
    allowed_stream_ids: [STREAM_A],
  };
}

export function credentialB(): Record<string, unknown> {
  return {
    producerId: PRODUCER_B,
    producer_id: PRODUCER_B,
    tenantId: TENANT_B,
    tenant_id: TENANT_B,
    secret: TEST_SECRET_B,
    // This deliberate overlap isolates tenant/producer authorization from
    // stream authorization in the cross-scope cases.
    allowedStreamIds: [STREAM_A, STREAM_B],
    allowed_stream_ids: [STREAM_A, STREAM_B],
  };
}
