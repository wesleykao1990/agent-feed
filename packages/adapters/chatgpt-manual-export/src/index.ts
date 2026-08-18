import { createHash } from "node:crypto";
import {
  LocalFileImportFailure,
  LocalFileRunBundleAdapter,
  createRunBundleValidator,
  LocalFileAdapterError,
  type LocalFileImportResult,
  type LocalFileRecoveryArtifact,
  type LocalFileRecoveryStore,
  type ProducerLifecycleService,
  type RunBundle,
} from "@agent-feed/local-file-adapter";
import type { ProducerPrincipal } from "@agent-feed/producer-service";

type JsonRecord = Record<string, unknown>;

export interface ChatGPTManualExportInput {
  /** Free-form task output, JSON text, or an already complete protocol bundle. */
  response: string | Uint8Array | JsonRecord;
  stream_id?: string;
  task?: JsonRecord;
  expected_scope?: JsonRecord;
  actual_scope?: JsonRecord;
  producer?: JsonRecord;
  run_id?: string;
  started_at?: string;
  status?: "completed" | "partial" | "failed" | "cancelled";
  metadata?: JsonRecord;
  source_uri?: string;
}

export interface ChatGPTManualMapperContext {
  run_id: string;
  captured_at: string;
  response_sha256: string;
  identity_sha256: string;
}

export interface ChatGPTManualMapperOutput {
  batches?: JsonRecord[];
  status?: "completed" | "partial" | "failed" | "cancelled";
  actual_scope?: JsonRecord;
  errors?: JsonRecord[];
  metadata?: JsonRecord;
}

export type ChatGPTManualMapper = (response: string, context: ChatGPTManualMapperContext) => ChatGPTManualMapperOutput | Promise<ChatGPTManualMapperOutput>;

export interface ChatGPTManualExportAdapterOptions {
  /** Direct submission is disabled unless this explicit capability is true. */
  direct_ingestion_capability?: boolean;
  service?: ProducerLifecycleService;
  principal?: ProducerPrincipal;
  mapper?: ChatGPTManualMapper;
  max_response_bytes?: number;
  max_excerpt_characters?: number;
  now?: () => Date;
  recovery_store?: LocalFileRecoveryStore;
  on_recovery?: (artifact: LocalFileRecoveryArtifact) => void | Promise<void>;
}

export interface ChatGPTManualExportResult {
  bundle: RunBundle;
  json: string;
  direct_ingestion_available: boolean;
}

export interface ChatGPTManualSubmitResult extends ChatGPTManualExportResult {
  imported: LocalFileImportResult;
}

export type ChatGPTManualExportErrorCode =
  | "response_too_large"
  | "invalid_response"
  | "secret_detected"
  | "bundle_invalid"
  | "mapping_failed"
  | "capability_unavailable"
  | "lifecycle_failed";

export class ChatGPTManualExportError extends Error {
  readonly code: ChatGPTManualExportErrorCode;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(code: ChatGPTManualExportErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "ChatGPTManualExportError";
    this.code = code;
    this.details = details;
  }
}

export class ChatGPTManualImportFailure extends ChatGPTManualExportError {
  readonly recovery!: LocalFileRecoveryArtifact;

  constructor(recovery: LocalFileRecoveryArtifact, details: Record<string, unknown> = {}) {
    super("lifecycle_failed", "ChatGPT manual export import failed; recovery material is available", details);
    this.name = "ChatGPTManualImportFailure";
    Object.defineProperty(this, "recovery", {
      value: recovery,
      enumerable: false,
      writable: false,
      configurable: false,
    });
  }

  toJSON(): Record<string, unknown> {
    return { name: this.name, code: this.code, message: this.message, details: this.details };
  }
}

function record(value: unknown): JsonRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : null;
}

function jsonText(value: string | Uint8Array | JsonRecord): string {
  if (typeof value === "string") return value;
  if (value instanceof Uint8Array) {
    try { return new TextDecoder("utf-8", { fatal: true }).decode(value); } catch { throw new ChatGPTManualExportError("invalid_response", "manual export response is not valid UTF-8"); }
  }
  try { return JSON.stringify(value); } catch { throw new ChatGPTManualExportError("invalid_response", "manual export response is not JSON serializable"); }
}

function secretLike(value: string): boolean {
  return /\b(?:bearer|password|passwd|secret|token|api[_ -]?key|access[_ -]?token|refresh[_ -]?token|authorization|cookie)\s*[:=]\s*\S+/iu.test(value);
}

function iso(now: Date, startedAt: string | undefined): string {
  const start = startedAt === undefined ? Number.NaN : Date.parse(startedAt);
  return new Date(Number.isFinite(start) ? Math.max(start, now.getTime()) : now.getTime()).toISOString();
}

/** Canonical JSON keeps generated identity keys stable across object key order. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
    const encoded = JSON.stringify(value);
    return encoded === undefined ? "null" : encoded;
  }
  if (value === undefined) return "null";
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  throw new Error("unsupported_identity_value");
}

function identityHash(input: ChatGPTManualExportInput, responseSha256: string, startedAt: string, capturedAt: string): string {
  const stream = input.stream_id ?? "chatgpt.manual-export";
  const producer = input.producer ?? { producer_id: "chatgpt-manual-export", type: "chatgpt", name: "ChatGPT manual export", version: "0.1.1" };
  const task = input.task ?? { task_type: "manual_monitor_export", definition_id: null, definition_version: null };
  const expectedScope = input.expected_scope ?? { source_ids: [], subjects: [], queries: [], metadata: {} };
  const material = {
    response_sha256: responseSha256,
    stream_id: stream,
    producer,
    task,
    expected_scope: expectedScope,
    actual_scope: input.actual_scope ?? null,
    source_uri: input.source_uri ?? null,
    run_id: input.run_id ?? null,
    started_at: startedAt,
    status: input.status ?? "completed",
    metadata: input.metadata ?? {},
    captured_at: capturedAt,
  };
  return createHash("sha256").update(canonicalJson(material), "utf8").digest("hex");
}

function generatedBundle(input: ChatGPTManualExportInput, response: string, context: ChatGPTManualMapperContext, mapped: ChatGPTManualMapperOutput | undefined, excerptLimit: number): RunBundle {
  const stream = input.stream_id ?? "chatgpt.manual-export";
  const runId = input.run_id ?? `run_chatgpt_manual_${context.identity_sha256.slice(0, 24)}`;
  const startedAt = input.started_at ?? context.captured_at;
  const producer = input.producer ?? { producer_id: "chatgpt-manual-export", type: "chatgpt", name: "ChatGPT manual export", version: "0.1.1" };
  const task = input.task ?? { task_type: "manual_monitor_export", definition_id: null, definition_version: null };
  const expectedScope = input.expected_scope ?? { source_ids: [], subjects: [], queries: [], metadata: {} };
  const batches = mapped?.batches ?? [];
  if (mapped === undefined && response.length > 0) {
    const excerpt = Array.from(response).slice(0, excerptLimit).join("");
    batches.push({
      protocol_version: "0.1",
      run_id: runId,
      batch_id: `batch_chatgpt_manual_${context.identity_sha256.slice(0, 16)}`,
      idempotency_key: `batch_chatgpt_manual_${context.identity_sha256.slice(0, 16)}`,
      sequence_number: 1,
      submitted_at: context.captured_at,
      findings: [],
      evidence: [{
        evidence_id: `evidence_chatgpt_manual_${context.identity_sha256.slice(0, 16)}`,
        kind: "other",
        source: {
          uri: input.source_uri ?? `urn:agent-feed:chatgpt-manual-export:${context.identity_sha256}`,
          title: "ChatGPT manual monitoring response",
          publisher: "ChatGPT",
          source_id: "chatgpt.manual-export",
        },
        captured_at: context.captured_at,
        published_at: null,
        locator: null,
        excerpt,
        content_hash: `sha256:${context.response_sha256}`,
        artifact: { uri: null, media_type: "text/plain", size_bytes: Buffer.byteLength(response, "utf8") },
        handling: { contains_personal_data: false, contains_secrets: false, redistribution_restricted: false },
        metadata: { untrusted_observation: true, response_sha256: context.response_sha256, truncated: Array.from(response).length > excerptLimit },
      }],
      metadata: { untrusted_observation: true },
    });
  }
  type GeneratedStats = { sources_attempted: number; sources_succeeded: number; batches_submitted: number; findings_submitted: number; evidence_submitted: number };
  const initialStats: GeneratedStats = { sources_attempted: 0, sources_succeeded: 0, batches_submitted: 0, findings_submitted: 0, evidence_submitted: 0 };
  const counts = batches.reduce<GeneratedStats>((stats, batch) => ({
    sources_attempted: stats.sources_attempted,
    sources_succeeded: stats.sources_succeeded,
    batches_submitted: stats.batches_submitted + 1,
    findings_submitted: stats.findings_submitted + (Array.isArray(batch.findings) ? batch.findings.length : 0),
    evidence_submitted: stats.evidence_submitted + (Array.isArray(batch.evidence) ? batch.evidence.length : 0),
  }), initialStats);
  const status = mapped?.status ?? input.status ?? "completed";
  const completeErrors = mapped?.errors ?? [];
  return {
    protocol_version: "0.1",
    run_id: runId,
    begin: {
      protocol_version: "0.1",
      idempotency_key: `begin_chatgpt_manual_${context.identity_sha256.slice(0, 16)}`,
      stream_id: stream,
      producer,
      task,
      expected_scope: expectedScope,
      started_at: startedAt,
      parent_run_id: null,
      metadata: { ...(input.metadata ?? {}), manual_export: true, untrusted_response: true },
    },
    batches,
    complete: {
      protocol_version: "0.1",
      run_id: runId,
      idempotency_key: `complete_chatgpt_manual_${context.identity_sha256.slice(0, 16)}`,
      status,
      completed_at: iso(new Date(context.captured_at), startedAt),
      actual_scope: input.actual_scope ?? mapped?.actual_scope ?? expectedScope,
      stats: counts,
      errors: completeErrors,
      metadata: { ...(input.metadata ?? {}), manual_export: true, untrusted_response: true },
    },
  };
}

function looksLikeBundle(value: unknown): value is RunBundle {
  const candidate = record(value);
  return candidate?.protocol_version === "0.1"
    && typeof candidate.run_id === "string"
    && candidate.begin !== undefined
    && Array.isArray(candidate.batches)
    && candidate.complete !== undefined;
}

/**
 * Capability-gated ChatGPT export path. In the normal Scheduled Task case it
 * emits a protocol-valid JSON bundle for local-file import. Direct ingestion
 * requires an explicit capability and injected service/principal.
 */
export class ChatGPTManualExportAdapter {
  readonly direct_ingestion_available: boolean;
  readonly max_response_bytes: number;
  readonly max_excerpt_characters: number;
  readonly #mapper: ChatGPTManualMapper | undefined;
  readonly #now: () => Date;
  readonly #service: ProducerLifecycleService | undefined;
  readonly #principal: ProducerPrincipal | undefined;
  readonly #validator = createRunBundleValidator();
  readonly #recoveryStore: LocalFileRecoveryStore | undefined;
  readonly #onRecovery: ((artifact: LocalFileRecoveryArtifact) => void | Promise<void>) | undefined;

  constructor(options: ChatGPTManualExportAdapterOptions = {}) {
    const maxBytes = options.max_response_bytes ?? 512 * 1024;
    const maxExcerpt = options.max_excerpt_characters ?? 4000;
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error("invalid_max_response_bytes");
    if (!Number.isSafeInteger(maxExcerpt) || maxExcerpt < 3 || maxExcerpt > 5000) throw new Error("invalid_max_excerpt_characters");
    const capability = options.direct_ingestion_capability === true;
    if (capability && (options.service === undefined || options.principal === undefined)) throw new Error("direct_ingestion_requires_service_and_principal");
    this.direct_ingestion_available = capability;
    this.max_response_bytes = maxBytes;
    this.max_excerpt_characters = maxExcerpt;
    this.#mapper = options.mapper;
    this.#now = options.now ?? (() => new Date());
    this.#service = options.service;
    this.#principal = options.principal;
    this.#recoveryStore = options.recovery_store;
    this.#onRecovery = options.on_recovery;
  }

  async exportBundle(input: ChatGPTManualExportInput): Promise<ChatGPTManualExportResult> {
    const text = jsonText(input.response);
    const size = Buffer.byteLength(text, "utf8");
    if (size > this.max_response_bytes) throw new ChatGPTManualExportError("response_too_large", "manual export response exceeds the configured limit", { max_response_bytes: this.max_response_bytes, actual_bytes: size });
    if (secretLike(text)) throw new ChatGPTManualExportError("secret_detected", "manual export response contains a credential-like value");
    const digest = createHash("sha256").update(text, "utf8").digest("hex");
    const now = this.#now();
    let parsed: unknown = text;
    try { parsed = JSON.parse(text) as unknown; } catch { /* free-form response is mapped below */ }
    if (looksLikeBundle(parsed)) {
      try {
        const bundle = this.#validator(parsed);
        return { bundle, json: JSON.stringify(bundle), direct_ingestion_available: this.direct_ingestion_available };
      } catch {
        throw new ChatGPTManualExportError("bundle_invalid", "manual export bundle does not match protocol 0.1");
      }
    }
    const capturedAt = input.started_at ?? now.toISOString();
    const startedAt = input.started_at ?? capturedAt;
    let identity: string;
    try {
      identity = identityHash(input, digest, startedAt, capturedAt);
    } catch {
      throw new ChatGPTManualExportError("invalid_response", "manual export identity material is not serializable");
    }
    const runId = input.run_id ?? `run_chatgpt_manual_${identity.slice(0, 24)}`;
    const context: ChatGPTManualMapperContext = {
      run_id: runId,
      captured_at: capturedAt,
      response_sha256: digest,
      identity_sha256: identity,
    };
    let mapped: ChatGPTManualMapperOutput | undefined;
    if (this.#mapper) {
      try {
        mapped = await this.#mapper(text, context);
      } catch {
        throw new ChatGPTManualExportError("mapping_failed", "manual export response mapping failed");
      }
    }
    const candidate = generatedBundle(input, text, context, mapped, this.max_excerpt_characters);
    try {
      const bundle = this.#validator(candidate);
      return { bundle, json: JSON.stringify(bundle), direct_ingestion_available: this.direct_ingestion_available };
    } catch (error) {
      const details = error instanceof LocalFileAdapterError && Array.isArray(error.details.errors)
        ? { schema_errors: error.details.errors }
        : {};
      throw new ChatGPTManualExportError("bundle_invalid", "generated manual export does not match protocol 0.1", details);
    }
  }

  export(input: ChatGPTManualExportInput): Promise<ChatGPTManualExportResult> {
    return this.exportBundle(input);
  }

  async buildRunBundle(input: ChatGPTManualExportInput): Promise<RunBundle> {
    return (await this.exportBundle(input)).bundle;
  }

  async toRunBundle(input: ChatGPTManualExportInput): Promise<RunBundle> {
    return (await this.exportBundle(input)).bundle;
  }

  async submit(input: ChatGPTManualExportInput): Promise<ChatGPTManualSubmitResult> {
    if (!this.direct_ingestion_available || !this.#service || !this.#principal) throw new ChatGPTManualExportError("capability_unavailable", "direct Agent Feed ingestion is not available; import the returned run bundle locally");
    const exported = await this.exportBundle(input);
    const adapter = new LocalFileRunBundleAdapter({
      service: this.#service,
      principal: this.#principal,
      max_bytes: this.max_response_bytes,
      ...(this.#recoveryStore === undefined ? {} : { recovery_store: this.#recoveryStore }),
      ...(this.#onRecovery === undefined ? {} : { on_recovery: this.#onRecovery }),
      now: this.#now,
    });
    try {
      const imported = await adapter.importJson(exported.json);
      return { ...exported, imported };
    } catch (error) {
      if (error instanceof LocalFileImportFailure) throw new ChatGPTManualImportFailure(error.recovery, { phase: error.details.phase, recovery_status: error.details.recovery_status });
      throw new ChatGPTManualExportError("lifecycle_failed", "manual export lifecycle failed", { phase: "begin" });
    }
  }
}

export const ChatGPTManualExport = ChatGPTManualExportAdapter;
