import { readFile } from "node:fs/promises";
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

export interface LocalFileRunBundleAdapterOptions {
  service: ProducerLifecycleService;
  principal: ProducerPrincipal;
  /** Maximum UTF-8 JSON bytes accepted from a local file. */
  max_bytes?: number;
}

export type LocalFileAdapterErrorCode =
  | "invalid_json"
  | "bundle_schema_validation_failed"
  | "bundle_run_id_mismatch"
  | "batch_run_id_mismatch"
  | "complete_run_id_mismatch"
  | "bundle_too_large";

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
    return JSON.parse(typeof value === "string" ? value : new TextDecoder().decode(value)) as unknown;
  } catch {
    throw new LocalFileAdapterError("invalid_json", "run bundle is not valid JSON");
  }
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
  readonly #validateBundle: (value: unknown) => RunBundle;

  constructor(options: LocalFileRunBundleAdapterOptions) {
    if (!Number.isSafeInteger(options.max_bytes ?? 1024 * 1024) || (options.max_bytes ?? 1024 * 1024) <= 0) {
      throw new Error("invalid_max_bytes");
    }
    this.service = options.service;
    this.principal = options.principal;
    this.max_bytes = options.max_bytes ?? 1024 * 1024;
    this.#validateBundle = createRunBundleValidator();
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
    const run = await this.service.beginRunWithWireId(bundle.run_id, bundle.begin, this.principal);
    const batches: unknown[] = [];
    for (const batch of bundle.batches) {
      batches.push(await this.service.submitBatch(bundle.run_id, batch, this.principal));
    }
    const complete = await this.service.completeRun(bundle.run_id, bundle.complete, this.principal);
    return { run, batches, complete };
  }

  /** Read and import one local UTF-8 JSON file. */
  async importFile(path: string | URL): Promise<LocalFileImportResult> {
    const content = await readFile(path);
    return this.importJson(content);
  }
}
