import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import {
  LocalFileAdapterError,
  LocalFileImportFailure,
  LocalFileRunBundleAdapter,
  type LocalFileImportResult,
  type LocalFileRecoveryArtifact,
  type LocalFileRecoveryStore,
  type ProducerLifecycleService,
  type RunBundle,
} from "@agent-feed/local-file-adapter";
import type { ProducerPrincipal } from "@agent-feed/producer-service";

type HeadersLike = Readonly<Record<string, string | readonly string[] | undefined>>;

export interface GenericWebhookRequest {
  raw_body: string | Uint8Array;
  headers?: HeadersLike;
}

export interface GenericWebhookContext {
  event_id: string;
  received_at: string;
  /** The raw upstream payload remains untrusted data; this only records that the MAC was verified. */
  signature: { algorithm: "hmac-sha256"; verified: true };
  /** Only non-sensitive, allowlisted transport headers are exposed to mappers. */
  headers: Readonly<Record<string, string>>;
}

export type GenericWebhookMapper = (payload: unknown, context: GenericWebhookContext) => RunBundle | Promise<RunBundle>;

/**
 * Optional durable replay boundary. `claim` must atomically reserve an event
 * ID for its body digest and return false for an already-reserved ID or a
 * conflicting digest. A durable implementation is required when replay
 * protection must survive adapter process restarts.
 */
export interface GenericWebhookReplayStore {
  claim(event_id: string, body_sha256: string): Promise<boolean>;
  release?(event_id: string, body_sha256: string): Promise<void>;
}

export interface GenericWebhookAdapterOptions {
  service: ProducerLifecycleService;
  principal: ProducerPrincipal;
  secret: string | Uint8Array;
  /** Maps untrusted upstream JSON into a protocol-valid, still-unverified run bundle. */
  mapper?: GenericWebhookMapper;
  max_body_bytes?: number;
  signature_header?: string;
  timestamp_header?: string;
  event_id_header?: string;
  replay_window_seconds?: number;
  replay_store?: GenericWebhookReplayStore;
  now?: () => Date;
  recovery_store?: LocalFileRecoveryStore;
  on_recovery?: (artifact: LocalFileRecoveryArtifact) => void | Promise<void>;
}

export interface GenericWebhookResult extends LocalFileImportResult {
  event_id: string;
  run_id: string;
}

export type GenericWebhookAdapterErrorCode =
  | "body_too_large"
  | "unsupported_media_type"
  | "invalid_json"
  | "signature_missing"
  | "signature_invalid"
  | "signature_timestamp_invalid"
  | "event_id_missing"
  | "event_replayed"
  | "replay_store_failed"
  | "mapping_failed"
  | "bundle_invalid"
  | "lifecycle_failed";

export class GenericWebhookAdapterError extends Error {
  readonly code: GenericWebhookAdapterErrorCode;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(code: GenericWebhookAdapterErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "GenericWebhookAdapterError";
    this.code = code;
    this.details = details;
  }
}

export class GenericWebhookImportFailure extends GenericWebhookAdapterError {
  readonly recovery!: LocalFileRecoveryArtifact;

  constructor(recovery: LocalFileRecoveryArtifact, details: Record<string, unknown> = {}) {
    super("lifecycle_failed", "webhook lifecycle failed; recovery material is available", details);
    this.name = "GenericWebhookImportFailure";
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

function header(headers: HeadersLike | undefined, name: string): string | undefined {
  if (!headers) return undefined;
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== wanted || value === undefined) continue;
    return typeof value === "string" ? value : value[0];
  }
  return undefined;
}

function bytes(value: string | Uint8Array, maxBytes: number): Uint8Array {
  const result = typeof value === "string" ? Buffer.from(value, "utf8") : value;
  if (result.byteLength > maxBytes) throw new GenericWebhookAdapterError("body_too_large", "webhook body exceeds the configured limit", { max_bytes: maxBytes });
  return result;
}

function digestHex(secret: string | Uint8Array, body: Uint8Array, timestamp: string | undefined): string {
  const message = timestamp === undefined
    ? body
    : Buffer.concat([Buffer.from(timestamp, "utf8"), Buffer.from(".", "utf8"), body]);
  return createHmac("sha256", secret).update(message).digest("hex");
}

function signatureParts(value: string): { digest: string; timestamp?: string } {
  const trimmed = value.trim();
  if (trimmed.length === 0) return { digest: "" };
  const pieces = trimmed.split(",").map((part) => part.trim());
  let timestamp: string | undefined;
  let digest = "";
  for (const piece of pieces) {
    const separator = piece.indexOf("=");
    if (separator < 1) {
      if (pieces.length === 1) digest = piece;
      continue;
    }
    const key = piece.slice(0, separator).toLowerCase();
    const item = piece.slice(separator + 1);
    if (key === "t") timestamp = item;
    if (key === "v1" || key === "sha256") digest = item;
  }
  return timestamp === undefined ? { digest } : { digest, timestamp };
}

function assertSignature(
  request: GenericWebhookRequest,
  body: Uint8Array,
  secret: string | Uint8Array,
  signatureHeader: string,
  timestampHeader: string,
  replayWindowSeconds: number,
  now: Date,
): void {
  const rawSignature = header(request.headers, signatureHeader);
  if (!rawSignature) throw new GenericWebhookAdapterError("signature_missing", "webhook signature is required");
  const parsed = signatureParts(rawSignature);
  const timestamp = parsed.timestamp ?? header(request.headers, timestampHeader);
  if (timestamp !== undefined) {
    const seconds = Number(timestamp);
    if (!Number.isSafeInteger(seconds) || Math.abs(Math.floor(now.getTime() / 1000) - seconds) > replayWindowSeconds) {
      throw new GenericWebhookAdapterError("signature_timestamp_invalid", "webhook signature timestamp is outside the replay window");
    }
  }
  if (!/^[0-9a-f]{64}$/u.test(parsed.digest)) throw new GenericWebhookAdapterError("signature_invalid", "webhook signature is invalid");
  const expected = digestHex(secret, body, timestamp);
  const presented = Buffer.from(parsed.digest, "hex");
  const calculated = Buffer.from(expected, "hex");
  if (presented.length !== calculated.length || !timingSafeEqual(presented, calculated)) {
    throw new GenericWebhookAdapterError("signature_invalid", "webhook signature is invalid");
  }
}

function eventId(request: GenericWebhookRequest, eventIdHeader: string): string {
  const provided = header(request.headers, eventIdHeader) ?? header(request.headers, "x-event-id") ?? header(request.headers, "x-webhook-id");
  const normalized = provided?.trim();
  if (normalized && /^[A-Za-z0-9._:-]{3,200}$/u.test(normalized)) return normalized;
  throw new GenericWebhookAdapterError("event_id_missing", "webhook event ID is required and must be stable");
}

function safeContextHeaders(headers: HeadersLike | undefined): Readonly<Record<string, string>> {
  const allowed = new Set(["content-type", "x-event-id", "x-webhook-id", "x-webhook-timestamp"]);
  const safe: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers ?? {})) {
    const normalized = key.trim().toLowerCase();
    if (!allowed.has(normalized) || value === undefined) continue;
    const scalar = typeof value === "string" ? value : value[0];
    if (scalar !== undefined) safe[normalized] = scalar;
  }
  return Object.freeze(safe);
}

function parsePayload(body: Uint8Array): unknown {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    throw new GenericWebhookAdapterError("invalid_json", "webhook body is not valid JSON");
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new GenericWebhookAdapterError("invalid_json", "webhook body is not valid JSON");
  }
}

function defaultMapper(payload: unknown): RunBundle {
  if (payload !== null && typeof payload === "object" && !Array.isArray(payload)) {
    const candidate = payload as Partial<RunBundle>;
    if (candidate.protocol_version === "0.1" && typeof candidate.run_id === "string" && Array.isArray(candidate.batches) && candidate.begin !== undefined && candidate.complete !== undefined) {
      return candidate as RunBundle;
    }
  }
  throw new GenericWebhookAdapterError("mapping_failed", "webhook payload requires an explicit run-bundle mapper");
}

/**
 * Verify and translate a third-party webhook, then use the validated local-file
 * lifecycle path. The upstream payload is never called a verified finding;
 * the mapper decides how to retain it as untrusted evidence/claims.
 */
export class GenericWebhookInputAdapter {
  readonly service: ProducerLifecycleService;
  readonly principal: ProducerPrincipal;
  readonly mapper: GenericWebhookMapper;
  readonly max_body_bytes: number;
  readonly signature_header: string;
  readonly timestamp_header: string;
  readonly event_id_header: string;
  readonly replay_window_seconds: number;
  readonly #now: () => Date;
  readonly #secret: Uint8Array;
  readonly #replayStore: GenericWebhookReplayStore | undefined;
  readonly #claimedEvents = new Map<string, string>();
  readonly #bundleAdapter: LocalFileRunBundleAdapter;

  constructor(options: GenericWebhookAdapterOptions) {
    const maxBytes = options.max_body_bytes ?? 1024 * 1024;
    const replayWindow = options.replay_window_seconds ?? 300;
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error("invalid_max_body_bytes");
    if (!Number.isSafeInteger(replayWindow) || replayWindow < 1) throw new Error("invalid_replay_window_seconds");
    if (typeof options.secret === "string" ? options.secret.length === 0 : options.secret.byteLength === 0) throw new Error("webhook_secret_required");
    this.service = options.service;
    this.principal = options.principal;
    this.#secret = typeof options.secret === "string" ? Buffer.from(options.secret, "utf8") : Buffer.from(options.secret);
    this.mapper = options.mapper ?? defaultMapper;
    this.max_body_bytes = maxBytes;
    this.signature_header = options.signature_header ?? "x-webhook-signature";
    this.timestamp_header = options.timestamp_header ?? "x-webhook-timestamp";
    this.event_id_header = options.event_id_header ?? "x-event-id";
    this.replay_window_seconds = replayWindow;
    this.#now = options.now ?? (() => new Date());
    this.#replayStore = options.replay_store;
    this.#bundleAdapter = new LocalFileRunBundleAdapter({
      service: options.service,
      principal: options.principal,
      max_bytes: maxBytes,
      ...(options.recovery_store === undefined ? {} : { recovery_store: options.recovery_store }),
      ...(options.on_recovery === undefined ? {} : { on_recovery: options.on_recovery }),
      now: this.#now,
    });
  }

  private async claimReplay(eventIdValue: string, bodySha256: string): Promise<void> {
    const existing = this.#claimedEvents.get(eventIdValue);
    if (existing !== undefined) throw new GenericWebhookAdapterError("event_replayed", "webhook event has already been claimed");
    this.#claimedEvents.set(eventIdValue, bodySha256);
    if (!this.#replayStore) return;
    try {
      if (!(await this.#replayStore.claim(eventIdValue, bodySha256))) {
        this.#claimedEvents.delete(eventIdValue);
        throw new GenericWebhookAdapterError("event_replayed", "webhook event has already been claimed");
      }
    } catch (error) {
      this.#claimedEvents.delete(eventIdValue);
      if (error instanceof GenericWebhookAdapterError) throw error;
      throw new GenericWebhookAdapterError("replay_store_failed", "webhook replay check failed");
    }
  }

  private async releaseReplay(eventIdValue: string, bodySha256: string): Promise<void> {
    if (this.#claimedEvents.get(eventIdValue) !== bodySha256) return;
    this.#claimedEvents.delete(eventIdValue);
    if (!this.#replayStore?.release) return;
    try { await this.#replayStore.release(eventIdValue, bodySha256); } catch { /* retain safe rejection on the durable boundary */ }
  }

  async ingest(request: GenericWebhookRequest): Promise<GenericWebhookResult> {
    const body = bytes(request.raw_body, this.max_body_bytes);
    const media = header(request.headers, "content-type")?.split(";", 1)[0]?.trim().toLowerCase();
    if (media !== undefined && media !== "application/json") throw new GenericWebhookAdapterError("unsupported_media_type", "webhook content-type must be application/json");
    assertSignature(request, body, this.#secret, this.signature_header, this.timestamp_header, this.replay_window_seconds, this.#now());
    const payload = parsePayload(body);
    const id = eventId(request, this.event_id_header);
    const bodySha256 = createHash("sha256").update(body).digest("hex");
    await this.claimReplay(id, bodySha256);
    const context: GenericWebhookContext = {
      event_id: id,
      received_at: this.#now().toISOString(),
      signature: { algorithm: "hmac-sha256", verified: true },
      headers: safeContextHeaders(request.headers),
    };
    let bundle: RunBundle;
    try {
      bundle = await this.mapper(payload, context);
    } catch (error) {
      await this.releaseReplay(id, bodySha256);
      if (error instanceof GenericWebhookAdapterError) throw error;
      throw new GenericWebhookAdapterError("mapping_failed", "webhook payload mapping failed");
    }
    let serializedBundle: string;
    try {
      serializedBundle = JSON.stringify(bundle);
      if (typeof serializedBundle !== "string") throw new Error("bundle_not_serializable");
    } catch {
      await this.releaseReplay(id, bodySha256);
      throw new GenericWebhookAdapterError("mapping_failed", "webhook mapper returned a non-serializable bundle");
    }
    let imported: LocalFileImportResult;
    try {
      imported = await this.#bundleAdapter.importJson(serializedBundle);
    } catch (error) {
      if (error instanceof LocalFileImportFailure) {
        throw new GenericWebhookImportFailure(error.recovery, { phase: error.details.phase, recovery_status: error.details.recovery_status });
      }
      if (error instanceof LocalFileAdapterError) {
        const schemaCode = error.code === "bundle_schema_validation_failed"
          || error.code === "bundle_run_id_mismatch"
          || error.code === "batch_run_id_mismatch"
          || error.code === "complete_run_id_mismatch";
        if (schemaCode) {
          await this.releaseReplay(id, bodySha256);
          throw new GenericWebhookAdapterError("bundle_invalid", "webhook mapper returned an invalid run bundle", {
            phase: "mapping",
            error_code: error.code,
          });
        }
        throw new GenericWebhookAdapterError("lifecycle_failed", "webhook lifecycle failed", {
          phase: error.details.phase ?? "lifecycle",
          error_code: error.code,
        });
      }
      throw new GenericWebhookAdapterError("lifecycle_failed", "webhook lifecycle failed", { phase: "lifecycle" });
    }
    return { ...imported, event_id: id, run_id: bundle.run_id };
  }

  handle(request: GenericWebhookRequest): Promise<GenericWebhookResult> {
    return this.ingest(request);
  }
}

export const GenericWebhookAdapter = GenericWebhookInputAdapter;
