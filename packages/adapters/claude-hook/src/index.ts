import {
  LocalFileImportFailure,
  type LocalFileRecoveryArtifact,
  type LocalFileRecoveryStore,
  type ProducerLifecycleService,
  type RunBundle,
} from "@agent-feed/local-file-adapter";
import type { ProducerPrincipal } from "@agent-feed/producer-service";

type JsonRecord = Record<string, unknown>;

export type ClaudeHookEventType = "run.started" | "batch.submitted" | "run.completed" | "run.partial" | "run.failed";

export interface ClaudeHookEvent {
  type: ClaudeHookEventType | "start" | "batch" | "complete" | "error" | "run.start" | "run.batch" | "run.complete" | "run.error" | "begin_run" | "submit_batch" | "complete_run";
  run_id: string;
  begin?: JsonRecord;
  batch?: JsonRecord;
  complete?: JsonRecord;
  /** Optional untrusted hook error metadata; it is never copied into diagnostics. */
  error?: unknown;
  payload?: JsonRecord;
}

export interface ClaudeHookAdapterOptions {
  service: ProducerLifecycleService;
  principal: ProducerPrincipal;
  max_event_bytes?: number;
  now?: () => Date;
  recovery_store?: LocalFileRecoveryStore;
  on_recovery?: (artifact: LocalFileRecoveryArtifact) => void | Promise<void>;
}

export interface ClaudeHookResult {
  type: ClaudeHookEventType;
  run_id: string;
  receipt: unknown;
  recovery?: {
    status: "closed";
    bundle: RunBundle;
  };
}

export type ClaudeHookAdapterErrorCode = "invalid_event" | "event_too_large" | "lifecycle_failed" | "run_not_active";

export class ClaudeHookAdapterError extends Error {
  readonly code: ClaudeHookAdapterErrorCode;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(code: ClaudeHookAdapterErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "ClaudeHookAdapterError";
    this.code = code;
    this.details = details;
  }
}

export class ClaudeHookImportFailure extends ClaudeHookAdapterError {
  readonly recovery!: LocalFileRecoveryArtifact;

  constructor(recovery: LocalFileRecoveryArtifact, details: Record<string, unknown> = {}) {
    super("lifecycle_failed", "Claude hook run failed; recovery material is available", details);
    this.name = "ClaudeHookImportFailure";
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

interface ActiveRun {
  run_id: string;
  begin: JsonRecord;
  batches: JsonRecord[];
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function safeCode(error: unknown): string {
  if (isRecord(error) && typeof error.code === "string" && /^[a-z0-9][a-z0-9._-]{0,80}$/u.test(error.code)) return error.code;
  return "storage_error";
}

function eventType(value: unknown): ClaudeHookEventType {
  if (!isRecord(value) || typeof value.type !== "string") throw new ClaudeHookAdapterError("invalid_event", "Claude hook event type is required");
  if (["start", "run.start", "run.started", "begin_run"].includes(value.type)) return "run.started";
  if (["batch", "run.batch", "batch.submitted", "submit_batch"].includes(value.type)) return "batch.submitted";
  if (["complete", "run.complete", "run.completed", "complete_run"].includes(value.type)) return "run.completed";
  if (value.type === "run.partial") return "run.partial";
  if (["error", "run.error", "run.failed", "failed"].includes(value.type)) return "run.failed";
  throw new ClaudeHookAdapterError("invalid_event", "Claude hook event type is not supported");
}

function payload(value: JsonRecord, key: "begin" | "batch" | "complete"): JsonRecord {
  const selected = value[key] ?? value.payload;
  if (!isRecord(selected)) throw new ClaudeHookAdapterError("invalid_event", `Claude hook ${key} payload is required`);
  return selected;
}

function runId(value: JsonRecord): string {
  if (typeof value.run_id !== "string" || value.run_id.length < 8 || value.run_id.length > 512 || value.run_id.includes("/")) {
    throw new ClaudeHookAdapterError("invalid_event", "Claude hook run_id is invalid");
  }
  return value.run_id;
}

function countStats(batches: readonly JsonRecord[]): { batches_submitted: number; findings_submitted: number; evidence_submitted: number } {
  type BatchStats = { batches_submitted: number; findings_submitted: number; evidence_submitted: number };
  const initial: BatchStats = { batches_submitted: 0, findings_submitted: 0, evidence_submitted: 0 };
  return batches.reduce<BatchStats>((stats, batch) => {
    const findings = Array.isArray(batch.findings) ? batch.findings.length : 0;
    const evidence = Array.isArray(batch.evidence) ? batch.evidence.length : 0;
    return { batches_submitted: stats.batches_submitted + 1, findings_submitted: stats.findings_submitted + findings, evidence_submitted: stats.evidence_submitted + evidence };
  }, initial);
}

function recoveryBundle(active: ActiveRun, status: "partial" | "failed", now: Date): RunBundle {
  const startedAt = typeof active.begin.started_at === "string" ? Date.parse(active.begin.started_at) : Number.NaN;
  const completedAt = new Date(Number.isFinite(startedAt) ? Math.max(startedAt, now.getTime()) : now.getTime()).toISOString();
  const expected = isRecord(active.begin.expected_scope) ? active.begin.expected_scope : { source_ids: [], subjects: [], queries: [], metadata: {} };
  const stats = countStats(active.batches);
  return {
    protocol_version: "0.1",
    run_id: active.run_id,
    begin: active.begin,
    batches: active.batches,
    complete: {
      protocol_version: "0.1",
      run_id: active.run_id,
      idempotency_key: `hook-recovery-${active.run_id}`,
      status,
      completed_at: completedAt,
      actual_scope: expected,
      stats: { sources_attempted: 0, sources_succeeded: 0, ...stats },
      errors: [{ code: "claude_hook_lifecycle_failed", message: "Claude hook lifecycle operation failed", source_id: null, retryable: true }],
      metadata: { adapter_recovery: { source: "claude-hook", status } },
    },
  };
}

/**
 * Bridges Claude hook lifecycle events to the producer service. State stores
 * only the exact begin/accepted-batch material needed to close a run after a
 * hook failure; it never performs persistence or validates protocol policy.
 */
export class ClaudeHookAdapter {
  readonly service: ProducerLifecycleService;
  readonly principal: ProducerPrincipal;
  readonly max_event_bytes: number;
  readonly #now: () => Date;
  readonly #recoveryStore: LocalFileRecoveryStore | undefined;
  readonly #onRecovery: ((artifact: LocalFileRecoveryArtifact) => void | Promise<void>) | undefined;
  readonly #active = new Map<string, ActiveRun>();

  constructor(options: ClaudeHookAdapterOptions) {
    const maxBytes = options.max_event_bytes ?? 256 * 1024;
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error("invalid_max_event_bytes");
    this.service = options.service;
    this.principal = options.principal;
    this.max_event_bytes = maxBytes;
    this.#now = options.now ?? (() => new Date());
    this.#recoveryStore = options.recovery_store;
    this.#onRecovery = options.on_recovery;
  }

  private assertSize(value: unknown): void {
    let encoded: string;
    try {
      const serialized = JSON.stringify(value);
      if (serialized === undefined) throw new Error("event_not_serializable");
      encoded = serialized;
    } catch {
      throw new ClaudeHookAdapterError("invalid_event", "Claude hook event is not JSON serializable");
    }
    if (Buffer.byteLength(encoded, "utf8") > this.max_event_bytes) throw new ClaudeHookAdapterError("event_too_large", "Claude hook event exceeds the configured limit", { max_event_bytes: this.max_event_bytes });
  }

  private async persistRecovery(artifact: LocalFileRecoveryArtifact): Promise<void> {
    if (this.#recoveryStore) {
      try { await this.#recoveryStore.persist(artifact); } catch { /* return artifact below */ }
    }
    if (this.#onRecovery) {
      try { await this.#onRecovery(artifact); } catch { /* observability cannot replace lifecycle state */ }
    }
  }

  private async closeFailure(active: ActiveRun, status: "partial" | "failed", phase: "batch" | "complete", error: unknown): Promise<ClaudeHookResult> {
    const bundle = recoveryBundle(active, status, this.#now());
    const artifact: LocalFileRecoveryArtifact = {
      protocol_version: "0.1",
      kind: "run-bundle-recovery",
      run_id: active.run_id,
      bundle,
      accepted_batch_count: active.batches.length,
      next_batch_index: active.batches.length,
      failure: { phase, code: safeCode(error), retryable: true },
    };
    try {
      const receipt = await this.service.completeRun(active.run_id, bundle.complete, this.principal);
      this.#active.delete(active.run_id);
      return { type: status === "failed" ? "run.failed" : "run.partial", run_id: active.run_id, receipt, recovery: { status: "closed", bundle } };
    } catch {
      await this.persistRecovery(artifact);
      throw new ClaudeHookImportFailure(artifact, { phase, recovery_status: "resumable" });
    }
  }

  private async preserveBeginFailure(runIdValue: string, begin: JsonRecord, error: unknown): Promise<never> {
    const active: ActiveRun = { run_id: runIdValue, begin, batches: [] };
    const bundle = recoveryBundle(active, "failed", this.#now());
    const artifact: LocalFileRecoveryArtifact = {
      protocol_version: "0.1",
      kind: "run-bundle-recovery",
      run_id: runIdValue,
      bundle,
      accepted_batch_count: 0,
      next_batch_index: 0,
      failure: { phase: "begin", code: safeCode(error), retryable: true },
    };
    await this.persistRecovery(artifact);
    throw new ClaudeHookImportFailure(artifact, { phase: "begin", recovery_status: "resumable" });
  }

  async handle(value: unknown): Promise<ClaudeHookResult> {
    this.assertSize(value);
    if (!isRecord(value)) throw new ClaudeHookAdapterError("invalid_event", "Claude hook event must be an object");
    const type = eventType(value);
    const id = runId(value);
    if (type === "run.started") {
      const begin = payload(value, "begin");
      try {
        const receipt = await this.service.beginRunWithWireId(id, begin, this.principal);
        if (!this.#active.has(id)) this.#active.set(id, { run_id: id, begin, batches: [] });
        return { type, run_id: id, receipt };
      } catch (error) {
        await this.preserveBeginFailure(id, begin, error);
      }
    }

    const active = this.#active.get(id);
    if (!active) throw new ClaudeHookAdapterError("run_not_active", "Claude hook run is not active", { run_id: id });
    if (type === "batch.submitted") {
      const batch = payload(value, "batch");
      try {
        const receipt = await this.service.submitBatch(id, batch, this.principal);
        active.batches.push(batch);
        return { type, run_id: id, receipt };
      } catch (error) {
        return this.closeFailure(active, "partial", "batch", error);
      }
    }
    if (type === "run.completed") {
      const complete = payload(value, "complete");
      try {
        const receipt = await this.service.completeRun(id, complete, this.principal);
        this.#active.delete(id);
        return { type, run_id: id, receipt };
      } catch (error) {
        return this.closeFailure(active, "partial", "complete", error);
      }
    }
    if (type === "run.partial") return this.closeFailure(active, "partial", "complete", value.error);
    return this.closeFailure(active, "failed", "complete", value.error);
  }

  handleEvent(value: unknown): Promise<ClaudeHookResult> {
    return this.handle(value);
  }

  handleHookEvent(value: unknown): Promise<ClaudeHookResult> {
    return this.handle(value);
  }

  async run(events: Iterable<unknown> | AsyncIterable<unknown>): Promise<ClaudeHookResult[]> {
    const results: ClaudeHookResult[] = [];
    for await (const event of events) results.push(await this.handle(event));
    return results;
  }
}

export const ClaudeHookInputAdapter = ClaudeHookAdapter;
