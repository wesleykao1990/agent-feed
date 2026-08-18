import { readFile, stat } from "node:fs/promises";
import type { URL } from "node:url";
import { runBundleSchema, schemas } from "@agent-feed/schema";
import type { ProducerPrincipal } from "@agent-feed/producer-service";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";

type JsonRecord = Record<string, unknown>;

/** The wire shape accepted by the local-file adapter. */
export interface RunBundle {
  protocol_version: "0.1";
  run_id: string;
  begin: JsonRecord;
  batches: JsonRecord[];
  complete: JsonRecord;
}

export interface ProducerLifecycleService {
  beginRunWithWireId(wireRunId: string, value: unknown, principal: ProducerPrincipal): Promise<unknown>;
  submitBatch(runId: string, value: unknown, principal: ProducerPrincipal): Promise<unknown>;
  completeRun(runId: string, value: unknown, principal: ProducerPrincipal): Promise<unknown>;
}

/**
 * A recovery sink is deliberately tiny. It may be backed by a local spool,
 * object storage, or a queue, but it must not be a database implementation
 * imported by this adapter. The exact bundle is retained so a later retry can
 * use the same idempotency keys and wire run ID.
 */
export interface LocalFileRecoveryStore {
  persist(artifact: LocalFileRecoveryArtifact): Promise<void>;
}

export interface LocalFileRecoveryArtifact {
  protocol_version: "0.1";
  kind: "run-bundle-recovery";
  run_id: string;
  bundle: RunBundle;
  accepted_batch_count: number;
  next_batch_index: number;
  failure: {
    phase: "begin" | "batch" | "complete";
    code: string;
    retryable: true;
  };
}

export interface LocalFileRunBundleAdapterOptions {
  service: ProducerLifecycleService;
  principal: ProducerPrincipal;
  /** Maximum UTF-8 JSON bytes accepted from a local file. */
  max_bytes?: number;
  /** Optional durable sink for recovery material after a lifecycle failure. */
  recovery_store?: LocalFileRecoveryStore;
  /** Optional process-local hook. Exceptions are swallowed and never replace the original failure. */
  on_recovery?: (artifact: LocalFileRecoveryArtifact) => void | Promise<void>;
  /** Clock used only for deterministic failure-completion timestamps. */
  now?: () => Date;
}

export type LocalFileAdapterErrorCode =
  | "invalid_json"
  | "bundle_schema_validation_failed"
  | "bundle_run_id_mismatch"
  | "batch_run_id_mismatch"
  | "complete_run_id_mismatch"
  | "bundle_too_large"
  | "file_read_failed"
  | "lifecycle_failed";

export class LocalFileAdapterError extends Error {
  readonly code: LocalFileAdapterErrorCode;
  readonly details: Record<string, unknown>;

  constructor(code: LocalFileAdapterErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "LocalFileAdapterError";
    this.code = code;
    this.details = details;
  }
}

/**
 * Raised when a lifecycle operation has an uncertain outcome. `recovery` is
 * intentionally a separate property rather than interpolated into the error
 * message or details, so normal diagnostics stay redacted while callers can
 * explicitly persist/replay the exact source bundle.
 */
export class LocalFileImportFailure extends LocalFileAdapterError {
  readonly recovery!: LocalFileRecoveryArtifact;

  constructor(message: string, recovery: LocalFileRecoveryArtifact, details: Record<string, unknown> = {}) {
    super("lifecycle_failed", message, details);
    this.name = "LocalFileImportFailure";
    // Recovery is exact replay material and may contain evidence. Keep it
    // explicitly accessible to the caller, but never let generic error
    // serialization copy it into logs or telemetry by accident.
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

export interface LocalFileImportResult {
  run: unknown;
  batches: readonly unknown[];
  complete: unknown;
}

const addFormats = addFormatsModule as unknown as (ajv: Ajv2020) => Ajv2020;

/**
 * Build a validator from the published schema package. The schema package is
 * the only contract source here; nested refs resolve through the exported
 * protocol schema IDs rather than a second handwritten bundle schema.
 */
export function createRunBundleValidator(): (value: unknown) => RunBundle {
  const ajv = new Ajv2020({ allErrors: true, strict: true, strictTypes: false });
  addFormats(ajv);
  for (const schema of Object.values(schemas)) ajv.addSchema(schema as Record<string, unknown>);
  const validate = ajv.compile(runBundleSchema as Record<string, unknown>);
  return (value: unknown): RunBundle => {
    if (!validate(value)) {
      const errors = (validate.errors ?? []).map((error) => ({
        path: error.instancePath || "$",
        message: error.message ?? "is invalid",
      }));
      throw new LocalFileAdapterError(
        "bundle_schema_validation_failed",
        "run bundle does not match the published protocol 0.1 schema",
        { errors },
      );
    }
    return value as RunBundle;
  };
}

function parseJson(value: string | Uint8Array): unknown {
  try {
    return JSON.parse(typeof value === "string" ? value : new TextDecoder("utf-8", { fatal: true }).decode(value)) as unknown;
  } catch {
    throw new LocalFileAdapterError("invalid_json", "run bundle is not valid JSON");
  }
}

function safeFailureCode(error: unknown): string {
  if (error !== null && typeof error === "object" && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && /^[a-z0-9][a-z0-9._-]{0,80}$/u.test(code)) return code;
  }
  return "storage_error";
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function isoAtOrAfter(startedAt: unknown, now: Date): string {
  const nowMs = now.getTime();
  const startedMs = typeof startedAt === "string" ? Date.parse(startedAt) : Number.NaN;
  return new Date(Number.isFinite(startedMs) ? Math.max(startedMs, nowMs) : nowMs).toISOString();
}

function acceptedCounts(bundle: RunBundle, acceptedBatchCount: number): {
  batches_submitted: number;
  findings_submitted: number;
  evidence_submitted: number;
} {
  const accepted = bundle.batches.slice(0, acceptedBatchCount);
  return {
    batches_submitted: accepted.length,
    findings_submitted: accepted.reduce((count, batch) => {
      const findings = batch.findings;
      return count + (Array.isArray(findings) ? findings.length : 0);
    }, 0),
    evidence_submitted: accepted.reduce((count, batch) => {
      const evidence = batch.evidence;
      return count + (Array.isArray(evidence) ? evidence.length : 0);
    }, 0),
  };
}

function recoveryCompletion(
  bundle: RunBundle,
  phase: "batch" | "complete",
  acceptedBatchCount: number,
  failureCode: string,
  now: Date,
): Record<string, unknown> {
  const complete = bundle.complete;
  const completeStats = objectValue(complete.stats);
  const counts = acceptedCounts(bundle, acceptedBatchCount);
  const attempted = typeof completeStats?.sources_attempted === "number" && Number.isSafeInteger(completeStats.sources_attempted)
    ? completeStats.sources_attempted
    : 0;
  const succeeded = typeof completeStats?.sources_succeeded === "number" && Number.isSafeInteger(completeStats.sources_succeeded)
    ? Math.min(Math.max(0, completeStats.sources_succeeded), Math.max(0, attempted))
    : 0;
  const actualScope = objectValue(complete.actual_scope) ?? objectValue(bundle.begin.expected_scope) ?? {
    source_ids: [],
    subjects: [],
    queries: [],
    metadata: {},
  };
  const idempotency = typeof complete.idempotency_key === "string" ? complete.idempotency_key : "complete-recovery";
  return {
    protocol_version: "0.1",
    run_id: bundle.run_id,
    idempotency_key: `recovery-${idempotency}`,
    status: "partial",
    completed_at: isoAtOrAfter(bundle.begin.started_at, now),
    actual_scope: actualScope,
    stats: {
      sources_attempted: Math.max(0, attempted),
      sources_succeeded: succeeded,
      ...counts,
    },
    errors: [{
      code: "adapter_lifecycle_failed",
      message: "adapter lifecycle operation failed",
      source_id: null,
      retryable: true,
    }],
    metadata: {
      adapter_recovery: {
        phase,
        next_batch_index: acceptedBatchCount,
        failure_code: failureCode,
      },
    },
  };
}

function assertRunIds(bundle: RunBundle): void {
  for (const [index, batch] of bundle.batches.entries()) {
    if (batch.run_id !== bundle.run_id) {
      throw new LocalFileAdapterError("batch_run_id_mismatch", "batch run_id does not match bundle run_id", {
        index,
        bundle_run_id: bundle.run_id,
        batch_run_id: batch.run_id,
      });
    }
  }
  if (bundle.complete.run_id !== bundle.run_id) {
    throw new LocalFileAdapterError("complete_run_id_mismatch", "complete run_id does not match bundle run_id", {
      bundle_run_id: bundle.run_id,
      complete_run_id: bundle.complete.run_id,
    });
  }
}

/**
 * Durable local-file importer. It validates the complete bundle before any
 * lifecycle call, then preserves bundle order while delegating all writes to
 * the injected producer application service.
 */
export class LocalFileRunBundleAdapter {
  readonly service: ProducerLifecycleService;
  readonly principal: ProducerPrincipal;
  readonly max_bytes: number;
  readonly recovery_store: LocalFileRecoveryStore | undefined;
  readonly on_recovery: ((artifact: LocalFileRecoveryArtifact) => void | Promise<void>) | undefined;
  readonly #validateBundle: (value: unknown) => RunBundle;
  readonly #now: () => Date;

  constructor(options: LocalFileRunBundleAdapterOptions) {
    if (!Number.isSafeInteger(options.max_bytes ?? 1024 * 1024) || (options.max_bytes ?? 1024 * 1024) <= 0) {
      throw new Error("invalid_max_bytes");
    }
    this.service = options.service;
    this.principal = options.principal;
    this.max_bytes = options.max_bytes ?? 1024 * 1024;
    this.recovery_store = options.recovery_store;
    this.on_recovery = options.on_recovery;
    this.#now = options.now ?? (() => new Date());
    this.#validateBundle = createRunBundleValidator();
  }

  private async persistRecovery(artifact: LocalFileRecoveryArtifact): Promise<void> {
    if (this.recovery_store) {
      try {
        await this.recovery_store.persist(artifact);
      } catch {
        // The returned LocalFileImportFailure still carries the exact artifact.
        // A failed diagnostic sink must never hide the original lifecycle error.
      }
    }
    if (this.on_recovery) {
      try {
        await this.on_recovery(artifact);
      } catch {
        // Hooks are observability/spooling conveniences, not lifecycle policy.
      }
    }
  }

  private async recoverAfterBegin(
    bundle: RunBundle,
    phase: "batch" | "complete",
    acceptedBatchCount: number,
    originalError: unknown,
  ): Promise<never> {
    const failureCode = safeFailureCode(originalError);
    const artifact: LocalFileRecoveryArtifact = {
      protocol_version: "0.1",
      kind: "run-bundle-recovery",
      run_id: bundle.run_id,
      bundle,
      accepted_batch_count: acceptedBatchCount,
      next_batch_index: acceptedBatchCount,
      failure: { phase, code: failureCode, retryable: true },
    };
    const completion = recoveryCompletion(bundle, phase, acceptedBatchCount, failureCode, this.#now());
    try {
      await this.service.completeRun(bundle.run_id, completion, this.principal);
      throw new LocalFileImportFailure(
        "run bundle import failed; a partial terminal receipt was recorded",
        artifact,
        { phase, accepted_batch_count: acceptedBatchCount, recovery_status: "closed" },
      );
    } catch (closeError) {
      // The deliberately thrown LocalFileImportFailure above means closure was
      // successful; preserve it rather than treating it as an unreachable run.
      if (closeError instanceof LocalFileImportFailure) throw closeError;
      await this.persistRecovery(artifact);
      throw new LocalFileImportFailure(
        "run bundle import failed; resumable recovery material is available",
        artifact,
        { phase, accepted_batch_count: acceptedBatchCount, recovery_status: "resumable" },
      );
    }
  }

  private async recoverBeginFailure(bundle: RunBundle, originalError: unknown): Promise<never> {
    const artifact: LocalFileRecoveryArtifact = {
      protocol_version: "0.1",
      kind: "run-bundle-recovery",
      run_id: bundle.run_id,
      bundle,
      accepted_batch_count: 0,
      next_batch_index: 0,
      failure: { phase: "begin", code: safeFailureCode(originalError), retryable: true },
    };
    await this.persistRecovery(artifact);
    throw new LocalFileImportFailure(
      "run bundle begin outcome is uncertain; resumable recovery material is available",
      artifact,
      { phase: "begin", accepted_batch_count: 0, recovery_status: "resumable" },
    );
  }

  /** Validate and import a UTF-8 JSON string or bytes. */
  async importJson(value: string | Uint8Array): Promise<LocalFileImportResult> {
    const bytes = typeof value === "string" ? Buffer.byteLength(value, "utf8") : value.byteLength;
    if (bytes > this.max_bytes) {
      throw new LocalFileAdapterError("bundle_too_large", "run bundle exceeds the configured byte limit", {
        max_bytes: this.max_bytes,
        actual_bytes: bytes,
      });
    }
    const bundle = this.#validateBundle(parseJson(value));
    assertRunIds(bundle);

    // Do not normalize, regenerate, or otherwise rewrite the wire ID. The
    // injected durable service owns idempotency and persistence semantics.
    let run: unknown;
    try {
      run = await this.service.beginRunWithWireId(bundle.run_id, bundle.begin, this.principal);
    } catch (error) {
      // A transport can fail after the service commits begin. Preserve an
      // exact retry bundle even when terminal closure is not safe to attempt.
      await this.recoverBeginFailure(bundle, error);
    }
    const batches: unknown[] = [];
    for (let index = 0; index < bundle.batches.length; index += 1) {
      const batch = bundle.batches[index]!;
      try {
        batches.push(await this.service.submitBatch(bundle.run_id, batch, this.principal));
      } catch (error) {
        await this.recoverAfterBegin(bundle, "batch", index, error);
      }
    }
    let complete: unknown;
    try {
      complete = await this.service.completeRun(bundle.run_id, bundle.complete, this.principal);
    } catch (error) {
      await this.recoverAfterBegin(bundle, "complete", bundle.batches.length, error);
    }
    return { run, batches, complete };
  }

  /** Read and import one local UTF-8 JSON file. */
  async importFile(path: string | URL): Promise<LocalFileImportResult> {
    let size: number;
    try {
      size = (await stat(path)).size;
    } catch {
      throw new LocalFileAdapterError("file_read_failed", "run bundle file could not be read");
    }
    if (!Number.isSafeInteger(size) || size > this.max_bytes) {
      throw new LocalFileAdapterError("bundle_too_large", "run bundle exceeds the configured byte limit", {
        max_bytes: this.max_bytes,
        actual_bytes: Number.isSafeInteger(size) ? size : null,
      });
    }
    let content: Buffer;
    try {
      content = await readFile(path);
    } catch {
      throw new LocalFileAdapterError("file_read_failed", "run bundle file could not be read");
    }
    return this.importJson(content);
  }
}
