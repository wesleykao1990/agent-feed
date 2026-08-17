import type {
  BeginRunRequest,
  CompleteRunRequest,
  EvidencePayload,
  FindingPayload,
  JsonObject,
  Scope,
  SubmitBatchRequest,
} from "@agent-feed/persistence-postgres";
import { schemas } from "@agent-feed/schema";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";
import { ProducerServiceError, type ProtocolValidationError, type ProtocolValidator } from "./types.ts";

const PRODUCER_TYPES = new Set(["chatgpt", "claude", "codex", "custom_agent", "human", "automation"]);
const TERMINAL_STATUSES = new Set(["completed", "partial", "failed", "cancelled"]);
const EVIDENCE_KINDS = new Set(["web", "document", "email", "api", "social_post", "database", "human_observation", "file", "other"]);
const BEGIN_KEYS = ["protocol_version", "idempotency_key", "stream_id", "producer", "task", "expected_scope", "started_at", "parent_run_id", "metadata"];
const SUBMIT_KEYS = ["protocol_version", "run_id", "batch_id", "idempotency_key", "sequence_number", "submitted_at", "findings", "evidence", "metadata"];
const COMPLETE_KEYS = ["protocol_version", "run_id", "idempotency_key", "status", "completed_at", "actual_scope", "stats", "errors", "metadata"];
const SCOPE_KEYS = ["source_ids", "subjects", "queries", "metadata"];
const PRODUCER_KEYS = ["producer_id", "type", "name", "version"];
const TASK_KEYS = ["task_type", "definition_id", "definition_version"];
const FINDING_KEYS = ["finding_id", "finding_type", "title", "summary", "subjects", "effective_time", "assessment", "evidence_refs", "producer_dedupe_key", "routing_tags", "attributes", "security_flags"];
const SUBJECT_KEYS = ["type", "id", "name"];
const EFFECTIVE_TIME_KEYS = ["occurred_at", "effective_from", "effective_to"];
const ASSESSMENT_KEYS = ["novelty", "source_authority_claim", "evidence_completeness", "agent_confidence"];
const EVIDENCE_KEYS = ["evidence_id", "kind", "source", "captured_at", "published_at", "locator", "excerpt", "content_hash", "artifact", "handling", "metadata"];
const SOURCE_KEYS = ["uri", "title", "publisher", "source_id"];
const LOCATOR_KEYS = ["type", "value", "page"];
const ARTIFACT_KEYS = ["uri", "media_type", "size_bytes"];
const HANDLING_KEYS = ["contains_personal_data", "contains_secrets", "redistribution_restricted"];
const STATS_KEYS = ["sources_attempted", "sources_succeeded", "findings_submitted", "evidence_submitted", "batches_submitted"];
const ERROR_KEYS = ["code", "message", "source_id", "retryable"];

const schemaValidator = new Ajv2020({ allErrors: true, strict: true, strictTypes: false });
const addFormats = addFormatsModule as unknown as (ajv: Ajv2020) => Ajv2020;
addFormats(schemaValidator);
for (const schema of Object.values(schemas)) schemaValidator.addSchema(schema as Record<string, unknown>);

type RecordValue = Record<string, unknown>;

function fail(path: string, message: string): never {
  const detail: ProtocolValidationError = { path, message };
  throw new ProducerServiceError("schema_validation_failed", `${path} ${message}`, { details: { errors: [detail] } });
}

function assertPublishedSchema(name: "beginRun" | "submitBatch" | "completeRun", value: unknown): void {
  const schema = schemas[name];
  const validator = schemaValidator.getSchema(String(schema.$id));
  if (!validator) throw new ProducerServiceError("schema_validation_failed", `published schema ${name} is unavailable`);
  if (validator(value)) return;
  const errors = (validator.errors ?? []).map((error) => ({
    path: error.instancePath || "$",
    message: error.message ?? "is invalid",
  }));
  throw new ProducerServiceError("schema_validation_failed", `${name} does not match published protocol 0.1 schema`, { details: { errors } });
}

function record(value: unknown, path: string): RecordValue {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(path, "must be an object");
  return value as RecordValue;
}

function exact(value: unknown, keys: readonly string[], path: string): RecordValue {
  const result = record(value, path);
  const expected = new Set(keys);
  for (const key of keys) if (!(key in result)) fail(`${path}.${key}`, "is required");
  for (const key of Object.keys(result)) if (!expected.has(key)) fail(`${path}.${key}`, "is not allowed");
  return result;
}

function string(value: unknown, path: string, options: { min?: number; max?: number; pattern?: RegExp } = {}): string {
  if (typeof value !== "string") fail(path, "must be a string");
  if (options.min !== undefined && value.length < options.min) fail(path, `must contain at least ${options.min} characters`);
  if (options.max !== undefined && value.length > options.max) fail(path, `must contain at most ${options.max} characters`);
  if (options.pattern !== undefined && !options.pattern.test(value)) fail(path, "has an invalid format");
  return value;
}

function nullableString(value: unknown, path: string): string | null {
  if (value === null) return null;
  return string(value, path);
}

function bool(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") fail(path, "must be a boolean");
  return value;
}

function integer(value: unknown, path: string, minimum = 0): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) fail(path, `must be an integer greater than or equal to ${minimum}`);
  return value;
}

function array(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) fail(path, "must be an array");
  return value;
}

function uniqueStrings(value: unknown, path: string): string[] {
  const values = array(value, path).map((item, index) => string(item, `${path}[${index}]`));
  if (new Set(values).size !== values.length) fail(path, "must not contain duplicates");
  return values;
}

function object(value: unknown, path: string): JsonObject {
  const result = record(value, path);
  // JSON.parse cannot produce undefined, functions, or symbols. This check
  // intentionally leaves arbitrary metadata keys open while still rejecting
  // arrays and null at the boundary.
  return result as JsonObject;
}

function dateTime(value: unknown, path: string): string {
  const result = string(value, path);
  if (Number.isNaN(Date.parse(result))) fail(path, "must be an ISO date-time");
  return result;
}

function scopeValue(value: unknown, path: string): Scope {
  const input = exact(value, SCOPE_KEYS, path);
  return {
    source_ids: uniqueStrings(input.source_ids, `${path}.source_ids`),
    subjects: uniqueStrings(input.subjects, `${path}.subjects`),
    queries: array(input.queries, `${path}.queries`).map((item, index) => string(item, `${path}.queries[${index}]`)),
    metadata: object(input.metadata, `${path}.metadata`),
  };
}

function producerValue(value: unknown, path: string): BeginRunRequest["producer"] {
  const input = exact(value, PRODUCER_KEYS, path);
  const type = string(input.type, `${path}.type`);
  if (!PRODUCER_TYPES.has(type)) fail(`${path}.type`, "is not a supported producer type");
  return {
    producer_id: string(input.producer_id, `${path}.producer_id`, { min: 1 }),
    type: type as BeginRunRequest["producer"]["type"],
    name: string(input.name, `${path}.name`, { min: 1 }),
    version: nullableString(input.version, `${path}.version`),
  };
}

function taskValue(value: unknown, path: string): BeginRunRequest["task"] {
  const input = exact(value, TASK_KEYS, path);
  return {
    task_type: string(input.task_type, `${path}.task_type`, { min: 1 }),
    definition_id: nullableString(input.definition_id, `${path}.definition_id`),
    definition_version: nullableString(input.definition_version, `${path}.definition_version`),
  };
}

function subjectValue(value: unknown, path: string): Record<string, unknown> {
  const input = exact(value, SUBJECT_KEYS, path);
  return {
    type: string(input.type, `${path}.type`, { min: 1 }),
    id: nullableString(input.id, `${path}.id`),
    name: nullableString(input.name, `${path}.name`),
  };
}

function findingValue(value: unknown, path: string): FindingPayload {
  const input = exact(value, FINDING_KEYS, path);
  const subjects = array(input.subjects, `${path}.subjects`);
  if (subjects.length === 0) fail(`${path}.subjects`, "must contain at least one subject");
  const effective = exact(input.effective_time, EFFECTIVE_TIME_KEYS, `${path}.effective_time`);
  const assessment = exact(input.assessment, ASSESSMENT_KEYS, `${path}.assessment`);
  const novelty = string(assessment.novelty, `${path}.assessment.novelty`);
  if (!new Set(["new", "known", "uncertain"]).has(novelty)) fail(`${path}.assessment.novelty`, "is not supported");
  const authority = string(assessment.source_authority_claim, `${path}.assessment.source_authority_claim`);
  if (!new Set(["primary", "official_secondary", "third_party", "unknown"]).has(authority)) fail(`${path}.assessment.source_authority_claim`, "is not supported");
  const completeness = string(assessment.evidence_completeness, `${path}.assessment.evidence_completeness`);
  if (!new Set(["complete", "partial", "lead_only"]).has(completeness)) fail(`${path}.assessment.evidence_completeness`, "is not supported");
  const confidence = assessment.agent_confidence === null ? null : assessment.agent_confidence;
  if (confidence !== null && (typeof confidence !== "number" || !Number.isFinite(confidence) || confidence < 0 || confidence > 1)) fail(`${path}.assessment.agent_confidence`, "must be between 0 and 1 or null");
  const evidenceRefs = uniqueStrings(input.evidence_refs, `${path}.evidence_refs`);
  const routingTags = uniqueStrings(input.routing_tags, `${path}.routing_tags`);
  const securityFlags = uniqueStrings(input.security_flags, `${path}.security_flags`);
  return {
    finding_id: string(input.finding_id, `${path}.finding_id`, { min: 3 }),
    finding_type: string(input.finding_type, `${path}.finding_type`, { pattern: /^[a-z0-9][a-z0-9._-]+$/u }),
    title: string(input.title, `${path}.title`, { min: 3, max: 300 }),
    summary: string(input.summary, `${path}.summary`, { min: 3, max: 5000 }),
    subjects: subjects.map((item, index) => subjectValue(item, `${path}.subjects[${index}]`)) as unknown as JsonObject[],
    effective_time: {
      occurred_at: effective.occurred_at === null ? null : dateTime(effective.occurred_at, `${path}.effective_time.occurred_at`),
      effective_from: effective.effective_from === null ? null : dateTime(effective.effective_from, `${path}.effective_time.effective_from`),
      effective_to: effective.effective_to === null ? null : dateTime(effective.effective_to, `${path}.effective_time.effective_to`),
    },
    assessment: {
      novelty,
      source_authority_claim: authority,
      evidence_completeness: completeness,
      agent_confidence: confidence,
    },
    evidence_refs: evidenceRefs,
    producer_dedupe_key: nullableString(input.producer_dedupe_key, `${path}.producer_dedupe_key`),
    routing_tags: routingTags,
    attributes: object(input.attributes, `${path}.attributes`),
    security_flags: securityFlags,
  } as unknown as FindingPayload;
}

function uriOrNull(value: unknown, path: string): string | null {
  const result = nullableString(value, path);
  if (result === null) return null;
  try {
    // URL accepts only absolute URLs, matching the JSON Schema's uri format
    // closely enough for the protocol boundary.
    new URL(result);
  } catch {
    fail(path, "must be a valid absolute URI or null");
  }
  return result;
}

function evidenceValue(value: unknown, path: string): EvidencePayload {
  const input = exact(value, EVIDENCE_KEYS, path);
  const kind = string(input.kind, `${path}.kind`);
  if (!EVIDENCE_KINDS.has(kind)) fail(`${path}.kind`, "is not supported");
  const source = exact(input.source, SOURCE_KEYS, `${path}.source`);
  const locator = input.locator === null
    ? null
    : (() => {
      const item = exact(input.locator, LOCATOR_KEYS, `${path}.locator`);
      const page = item.page === null ? null : integer(item.page, `${path}.locator.page`, 1);
      return { type: string(item.type, `${path}.locator.type`), value: string(item.value, `${path}.locator.value`), page };
    })();
  const artifact = exact(input.artifact, ARTIFACT_KEYS, `${path}.artifact`);
  const handling = exact(input.handling, HANDLING_KEYS, `${path}.handling`);
  const excerpt = nullableString(input.excerpt, `${path}.excerpt`);
  // JSON Schema's maxLength is defined in Unicode code points. Counting JS
  // UTF-16 code units would reject valid astral characters prematurely.
  if (excerpt !== null && Array.from(excerpt).length > 5000) fail(`${path}.excerpt`, "is too long");
  const contentHash = nullableString(input.content_hash, `${path}.content_hash`);
  if (contentHash !== null && !/^sha256:[0-9a-f]{64}$/u.test(contentHash)) fail(`${path}.content_hash`, "must be a sha256 digest");
  return {
    evidence_id: string(input.evidence_id, `${path}.evidence_id`, { min: 3 }),
    kind: kind as EvidencePayload["kind"],
    source: {
      uri: uriOrNull(source.uri, `${path}.source.uri`),
      title: nullableString(source.title, `${path}.source.title`),
      publisher: nullableString(source.publisher, `${path}.source.publisher`),
      source_id: nullableString(source.source_id, `${path}.source.source_id`),
    },
    captured_at: dateTime(input.captured_at, `${path}.captured_at`),
    published_at: input.published_at === null ? null : dateTime(input.published_at, `${path}.published_at`),
    locator,
    excerpt,
    content_hash: contentHash,
    artifact: {
      uri: uriOrNull(artifact.uri, `${path}.artifact.uri`),
      media_type: nullableString(artifact.media_type, `${path}.artifact.media_type`),
      size_bytes: artifact.size_bytes === null ? null : integer(artifact.size_bytes, `${path}.artifact.size_bytes`),
    },
    handling: {
      contains_personal_data: bool(handling.contains_personal_data, `${path}.handling.contains_personal_data`),
      contains_secrets: bool(handling.contains_secrets, `${path}.handling.contains_secrets`),
      redistribution_restricted: bool(handling.redistribution_restricted, `${path}.handling.redistribution_restricted`),
    },
    metadata: object(input.metadata, `${path}.metadata`),
  };
}

function begin(value: unknown): BeginRunRequest {
  assertPublishedSchema("beginRun", value);
  const input = exact(value, BEGIN_KEYS, "$" );
  if (input.protocol_version !== "0.1") fail("$.protocol_version", "must be 0.1");
  return {
    protocol_version: "0.1",
    idempotency_key: string(input.idempotency_key, "$.idempotency_key", { min: 8 }),
    stream_id: string(input.stream_id, "$.stream_id", { pattern: /^[a-z0-9][a-z0-9._-]+$/u }),
    producer: producerValue(input.producer, "$.producer"),
    task: taskValue(input.task, "$.task"),
    expected_scope: scopeValue(input.expected_scope, "$.expected_scope"),
    started_at: dateTime(input.started_at, "$.started_at"),
    parent_run_id: nullableString(input.parent_run_id, "$.parent_run_id"),
    metadata: object(input.metadata, "$.metadata"),
  };
}

function submit(value: unknown): SubmitBatchRequest {
  assertPublishedSchema("submitBatch", value);
  const input = exact(value, SUBMIT_KEYS, "$" );
  if (input.protocol_version !== "0.1") fail("$.protocol_version", "must be 0.1");
  const findings = array(input.findings, "$.findings");
  const evidence = array(input.evidence, "$.evidence");
  if (findings.length === 0 && evidence.length === 0) fail("$", "findings or evidence is required");
  if (findings.length > 100) fail("$.findings", "contains too many items");
  if (evidence.length > 500) fail("$.evidence", "contains too many items");
  return {
    protocol_version: "0.1",
    run_id: string(input.run_id, "$.run_id", { min: 8 }),
    batch_id: string(input.batch_id, "$.batch_id", { min: 3 }),
    idempotency_key: string(input.idempotency_key, "$.idempotency_key", { min: 8 }),
    sequence_number: integer(input.sequence_number, "$.sequence_number", 1),
    submitted_at: dateTime(input.submitted_at, "$.submitted_at"),
    findings: findings.map((item, index) => findingValue(item, `$.findings[${index}]`)),
    evidence: evidence.map((item, index) => evidenceValue(item, `$.evidence[${index}]`)),
    metadata: object(input.metadata, "$.metadata"),
  };
}

function complete(value: unknown): CompleteRunRequest {
  assertPublishedSchema("completeRun", value);
  const input = exact(value, COMPLETE_KEYS, "$" );
  if (input.protocol_version !== "0.1") fail("$.protocol_version", "must be 0.1");
  const status = string(input.status, "$.status");
  if (!TERMINAL_STATUSES.has(status)) fail("$.status", "must be terminal");
  const stats = exact(input.stats, STATS_KEYS, "$.stats");
  const errors = array(input.errors, "$.errors").map((item, index) => {
    const error = exact(item, ERROR_KEYS, `$.errors[${index}]`);
    return {
      code: string(error.code, `$.errors[${index}].code`),
      message: string(error.message, `$.errors[${index}].message`),
      source_id: nullableString(error.source_id, `$.errors[${index}].source_id`),
      retryable: bool(error.retryable, `$.errors[${index}].retryable`),
    };
  });
  return {
    protocol_version: "0.1",
    run_id: string(input.run_id, "$.run_id", { min: 8 }),
    idempotency_key: string(input.idempotency_key, "$.idempotency_key", { min: 8 }),
    status: status as CompleteRunRequest["status"],
    completed_at: dateTime(input.completed_at, "$.completed_at"),
    actual_scope: scopeValue(input.actual_scope, "$.actual_scope"),
    stats: {
      sources_attempted: integer(stats.sources_attempted, "$.stats.sources_attempted"),
      sources_succeeded: integer(stats.sources_succeeded, "$.stats.sources_succeeded"),
      findings_submitted: integer(stats.findings_submitted, "$.stats.findings_submitted"),
      evidence_submitted: integer(stats.evidence_submitted, "$.stats.evidence_submitted"),
      batches_submitted: integer(stats.batches_submitted, "$.stats.batches_submitted"),
    },
    errors,
    metadata: object(input.metadata, "$.metadata"),
  };
}

export const defaultProtocolValidator: ProtocolValidator = { begin, submit, complete };
