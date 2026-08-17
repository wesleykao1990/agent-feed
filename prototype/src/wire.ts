import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { ErrorObject, ValidateFunction } from "ajv";
import type { FormatsPlugin } from "ajv-formats";
import { SECURITY_DEFAULTS } from "./security.ts";
import { AgentFeedStore } from "./store.ts";
import type { Finding, RunRecord, Scope, SubmittedEvidence } from "./types.ts";

const require = createRequire(import.meta.url);
const addFormats = require("ajv-formats") as FormatsPlugin;

interface WireScope {
  source_ids: string[];
  subjects: string[];
  queries: string[];
  metadata: Record<string, unknown>;
}

interface WireFinding extends Record<string, unknown> {
  finding_id: string;
  finding_type: string;
  title: string;
  summary: string;
  subjects: Array<{ type: string; id: string | null; name: string | null }>;
  evidence_refs: string[];
  security_flags: string[];
  attributes: Record<string, unknown>;
}

interface WireEvidence extends Record<string, unknown> {
  evidence_id: string;
  kind: string;
  source: { uri: string | null };
  excerpt: string | null;
  handling: {
    contains_personal_data: boolean;
    contains_secrets: boolean;
    redistribution_restricted: boolean;
  };
}

interface WireBatch {
  run_id: string;
  batch_id: string;
  idempotency_key: string;
  sequence_number: number;
  findings: WireFinding[];
  evidence: WireEvidence[];
}

interface WireRunBundle {
  protocol_version: "0.1";
  run_id: string;
  begin: {
    idempotency_key: string;
    stream_id: string;
    producer: { producer_id: string };
    expected_scope: WireScope;
    started_at: string;
  };
  batches: WireBatch[];
  complete: {
    run_id: string;
    idempotency_key: string;
    status: "completed" | "partial" | "failed" | "cancelled";
    completed_at: string;
    actual_scope: WireScope;
    stats: {
      sources_attempted: number;
      sources_succeeded: number;
      findings_submitted: number;
      evidence_submitted: number;
      batches_submitted: number;
    };
    errors: Array<{ message: string }>;
  };
}

const schemaNames = [
  "begin-run.schema.json",
  "complete-run.schema.json",
  "delivery-event.schema.json",
  "evidence.schema.json",
  "finding.schema.json",
  "run-bundle.schema.json",
  "run-envelope.schema.json",
  "stream-expectation.schema.json",
  "submit-batch.schema.json",
] as const;

function loadSchema(name: string): Record<string, unknown> {
  const url = new URL(`../../packages/schema/contracts/${name}`, import.meta.url);
  return JSON.parse(readFileSync(url, "utf8")) as Record<string, unknown>;
}

function createRunBundleValidator(): ValidateFunction<WireRunBundle> {
  const ajv = new Ajv2020({ allErrors: true, strict: true, strictTypes: false });
  addFormats(ajv);
  for (const name of schemaNames) ajv.addSchema(loadSchema(name));
  const validator = ajv.getSchema<WireRunBundle>(
    "https://agent-feed.dev/schemas/run-bundle.schema.json",
  );
  if (!validator) throw new Error("run_bundle_schema_not_registered");
  return validator;
}

const validateRunBundle = createRunBundleValidator();

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function payloadHash(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

function validationMessage(errors: ErrorObject[] | null | undefined): string {
  return (errors ?? [])
    .map((error) => `${error.instancePath || "/"} ${error.message ?? "is invalid"}`)
    .join("; ");
}

function assertRunBundle(value: unknown): asserts value is WireRunBundle {
  if (!validateRunBundle(value)) {
    throw new Error(`schema_validation_failed:${validationMessage(validateRunBundle.errors)}`);
  }
}

function scope(value: WireScope): Scope {
  return {
    sourceIds: structuredClone(value.source_ids),
    subjects: structuredClone(value.subjects),
    queries: structuredClone(value.queries),
  };
}

function finding(value: WireFinding): Finding {
  return {
    findingId: value.finding_id,
    findingType: value.finding_type,
    title: value.title,
    summary: value.summary,
    subjects: structuredClone(value.subjects),
    evidenceRefs: structuredClone(value.evidence_refs),
    securityFlags: structuredClone(value.security_flags),
    attributes: structuredClone(value.attributes),
    wirePayload: structuredClone(value),
  };
}

function evidence(value: WireEvidence): SubmittedEvidence {
  return {
    evidenceId: value.evidence_id,
    kind: value.kind,
    sourceUri: value.source.uri,
    excerpt: value.excerpt,
    handling: {
      containsPersonalData: value.handling.contains_personal_data,
      containsSecrets: value.handling.contains_secrets,
      redistributionRestricted: value.handling.redistribution_restricted,
    },
    wirePayload: structuredClone(value),
  };
}

function assertBundleSemantics(bundle: WireRunBundle): void {
  if (bundle.complete.run_id !== bundle.run_id) throw new Error("bundle_run_id_mismatch:complete");

  const findingIds = new Set<string>();
  const evidenceIds = new Set<string>();
  const batchIds = new Set<string>();
  const batchIdempotencyKeys = new Set<string>();
  let lastSequence = 0;
  let findingCount = 0;
  let evidenceCount = 0;

  for (const batch of bundle.batches) {
    if (batch.run_id !== bundle.run_id) throw new Error(`bundle_run_id_mismatch:${batch.batch_id}`);
    if (batch.sequence_number <= lastSequence) throw new Error("batch_sequence_not_increasing");
    if (batchIds.has(batch.batch_id)) throw new Error(`duplicate_batch:${batch.batch_id}`);
    if (batchIdempotencyKeys.has(batch.idempotency_key)) {
      throw new Error(`duplicate_batch_idempotency_key:${batch.idempotency_key}`);
    }
    if (
      batch.findings.length > SECURITY_DEFAULTS.maxFindingsPerBatch ||
      batch.evidence.length > SECURITY_DEFAULTS.maxEvidencePerBatch
    ) {
      throw new Error("batch_limit_exceeded");
    }
    batchIds.add(batch.batch_id);
    batchIdempotencyKeys.add(batch.idempotency_key);
    lastSequence = batch.sequence_number;
    for (const item of batch.evidence) {
      if (item.handling.contains_secrets) throw new Error(`secret_bearing_evidence_rejected:${item.evidence_id}`);
      if ((item.excerpt?.length ?? 0) > SECURITY_DEFAULTS.maxEvidenceExcerptCharacters) {
        throw new Error(`evidence_excerpt_too_large:${item.evidence_id}`);
      }
      if (evidenceIds.has(item.evidence_id)) throw new Error(`duplicate_evidence:${item.evidence_id}`);
      evidenceIds.add(item.evidence_id);
      evidenceCount += 1;
    }
    for (const item of batch.findings) {
      if (findingIds.has(item.finding_id)) throw new Error(`duplicate_finding:${item.finding_id}`);
      findingIds.add(item.finding_id);
      findingCount += 1;
      for (const reference of item.evidence_refs) {
        if (!evidenceIds.has(reference)) throw new Error(`unresolved_evidence_ref:${reference}`);
      }
    }
  }

  const stats = bundle.complete.stats;
  if (
    stats.batches_submitted !== bundle.batches.length ||
    stats.findings_submitted !== findingCount ||
    stats.evidence_submitted !== evidenceCount
  ) {
    throw new Error("completion_counts_do_not_reconcile");
  }
  if (stats.sources_succeeded > stats.sources_attempted) throw new Error("invalid_scope_stats");
  if (Date.parse(bundle.complete.completed_at) < Date.parse(bundle.begin.started_at)) {
    throw new Error("completion_before_start");
  }
}

export interface ImportResult {
  imported: boolean;
  payloadHash: string;
  run: RunRecord;
}

export class RunBundleImporter {
  readonly #receipts = new Map<string, string>();
  readonly store: AgentFeedStore;

  constructor(store: AgentFeedStore) {
    this.store = store;
  }

  import(bundleValue: unknown): ImportResult {
    assertRunBundle(bundleValue);
    assertBundleSemantics(bundleValue);
    const hash = payloadHash(bundleValue);
    const previous = this.#receipts.get(bundleValue.run_id);
    if (previous) {
      if (previous !== hash) throw new Error("idempotency_payload_conflict");
      const run = this.store.getRun(bundleValue.run_id);
      if (!run) throw new Error(`run_not_found:${bundleValue.run_id}`);
      return { imported: false, payloadHash: hash, run };
    }
    if (this.store.getRun(bundleValue.run_id)) throw new Error(`run_id_conflict:${bundleValue.run_id}`);

    this.store.beginRun({
      runId: bundleValue.run_id,
      streamId: bundleValue.begin.stream_id,
      producerId: bundleValue.begin.producer.producer_id,
      idempotencyKey: bundleValue.begin.idempotency_key,
      startedAt: bundleValue.begin.started_at,
      expectedScope: scope(bundleValue.begin.expected_scope),
    });
    for (const batch of bundleValue.batches) {
      this.store.submitBatch({
        runId: batch.run_id,
        batchId: batch.batch_id,
        idempotencyKey: batch.idempotency_key,
        findings: batch.findings.map(finding),
        evidence: batch.evidence.map(evidence),
      });
    }
    const run = this.store.completeRun({
      runId: bundleValue.complete.run_id,
      idempotencyKey: bundleValue.complete.idempotency_key,
      status: bundleValue.complete.status,
      completedAt: bundleValue.complete.completed_at,
      actualScope: scope(bundleValue.complete.actual_scope),
      sourcesAttempted: bundleValue.complete.stats.sources_attempted,
      sourcesSucceeded: bundleValue.complete.stats.sources_succeeded,
      errorSummary:
        bundleValue.complete.errors.length > 0
          ? bundleValue.complete.errors.map((error) => error.message).join("; ")
          : null,
    });
    this.#receipts.set(bundleValue.run_id, hash);
    return { imported: true, payloadHash: hash, run };
  }

  importJson(rawBody: string): ImportResult {
    if (Buffer.byteLength(rawBody) > SECURITY_DEFAULTS.maxBodyBytes) throw new Error("body_too_large");
    let value: unknown;
    try {
      value = JSON.parse(rawBody);
    } catch {
      throw new Error("invalid_json");
    }
    return this.import(value);
  }
}
