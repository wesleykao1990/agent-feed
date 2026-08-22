import { createHash, timingSafeEqual } from "node:crypto";
import { types as nodeTypes } from "node:util";
import { defaultProtocolValidator } from "./validation.ts";
import {
  ProducerServiceError,
  type BeginRunRequest,
  type CompleteRunRequest,
  type PersistenceErrorCode,
  type ProducerAuthenticationRequest,
  type ProducerAuthenticator,
  type ProducerCredential,
  type ProducerPersistence,
  type ProducerPrincipal,
  type ProducerServiceOptions,
  type ProtocolValidator,
  type QuarantineEvent,
  type RateLimitDecision,
  type RateLimitOptions,
  type SecurityPolicy,
  type RunRecord,
  type SubmitBatchRequest,
  statusForProducerError,
} from "./types.ts";

export const SECURITY_DEFAULTS = Object.freeze({
  max_body_bytes: 1024 * 1024,
  max_findings_per_batch: 100,
  max_evidence_per_batch: 100,
  max_evidence_excerpt_characters: 4000,
  max_evidence_metadata_bytes: 64 * 1024,
  producer_requests_per_minute: 60,
  producer_burst: 10,
  producer_burst_window_ms: 1000,
});

export const DEFAULT_SECURITY_POLICY: SecurityPolicy = Object.freeze({
  max_body_bytes: SECURITY_DEFAULTS.max_body_bytes,
  max_findings_per_batch: SECURITY_DEFAULTS.max_findings_per_batch,
  max_evidence_per_batch: SECURITY_DEFAULTS.max_evidence_per_batch,
  max_evidence_excerpt_characters: SECURITY_DEFAULTS.max_evidence_excerpt_characters,
  max_evidence_metadata_bytes: SECURITY_DEFAULTS.max_evidence_metadata_bytes,
  reject_secrets: true,
  reject_personal_data: false,
  quarantine_personal_data: true,
  quarantine_hostile_findings: true,
});

const PERSISTENCE_ERROR_CODES = new Set<PersistenceErrorCode>([
  "idempotency_payload_conflict",
  "run_not_found",
  "run_id_conflict",
  "terminal_run_immutable",
  "batch_not_found",
  "batch_id_conflict",
  "batch_sequence_not_increasing",
  "duplicate_finding",
  "duplicate_evidence",
  "unresolved_evidence_ref",
  "completion_before_start",
  "invalid_scope_stats",
  "completion_counts_do_not_reconcile",
  "invalid_input",
  "storage_error",
]);

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

export function constantTimeEqual(left: string, right: string): boolean {
  return timingSafeEqual(digest(left), digest(right));
}

function expirySeconds(value: ProducerCredential["expires_at"]): number | null {
  if (value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : Number.NaN;
  if (value instanceof Date) return value.getTime() / 1000;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? Number.NaN : parsed / 1000;
}

function bearerSecret(authorization: string | undefined): string | null {
  if (!authorization) return null;
  const match = /^Bearer[ \t]+([^ \t]+)[ \t]*$/iu.exec(authorization);
  return match?.[1] ?? null;
}

/**
 * Constant-time bearer verification over all configured credentials. A
 * credential is scoped to exactly one tenant, producer identity, and stream
 * set; the HTTP adapter never trusts those values from request headers.
 */
export class StaticProducerAuthenticator implements ProducerAuthenticator {
  readonly #credentials: readonly (ProducerCredential & { digest: Buffer })[];

  constructor(credentials: readonly ProducerCredential[]) {
    if (credentials.length === 0) throw new Error("at_least_one_producer_credential_required");
    this.#credentials = credentials.map((credential) => {
      if (!credential.tenant_id || !credential.producer_id || !credential.secret || credential.allowed_stream_ids.length === 0) {
        throw new Error("invalid_producer_credential");
      }
      if (credential.producer_id === "*" || credential.allowed_stream_ids.includes("*")) {
        throw new Error("wildcard_producer_credentials_are_not_allowed");
      }
      return { ...credential, digest: digest(credential.secret) };
    });
  }

  authenticate(request: ProducerAuthenticationRequest): ProducerPrincipal | null {
    const presented = bearerSecret(request.authorization);
    if (!presented) return null;
    const presentedDigest = digest(presented);
    const nowSeconds = request.now_seconds ?? Math.floor(Date.now() / 1000);
    let match: (ProducerCredential & { digest: Buffer }) | null = null;
    let expired = false;
    for (const credential of this.#credentials) {
      const equal = timingSafeEqual(presentedDigest, credential.digest);
      if (equal && match === null) {
        match = credential;
        const expires = expirySeconds(credential.expires_at);
        expired = expires !== null && (!Number.isFinite(expires) || nowSeconds >= expires);
      }
    }
    if (!match || expired) return null;
    const principal: ProducerPrincipal = {
      tenant_id: match.tenant_id,
      producer_id: match.producer_id,
      allowed_stream_ids: [...match.allowed_stream_ids],
    };
    if (match.credential_id !== undefined) principal.credential_id = match.credential_id;
    return principal;
  }
}

export class ProducerRateLimiter {
  readonly #maxRequests: number;
  readonly #windowMs: number;
  readonly #burst: number;
  readonly #burstWindowMs: number;
  readonly #now: () => number;
  readonly #requests = new Map<string, number[]>();

  constructor(options: RateLimitOptions = {}) {
    this.#maxRequests = options.max_requests_per_minute ?? SECURITY_DEFAULTS.producer_requests_per_minute;
    this.#windowMs = options.window_ms ?? 60_000;
    this.#burst = options.burst ?? SECURITY_DEFAULTS.producer_burst;
    this.#burstWindowMs = options.burst_window_ms ?? SECURITY_DEFAULTS.producer_burst_window_ms;
    this.#now = options.now ?? (() => Date.now());
    if (!Number.isInteger(this.#maxRequests) || this.#maxRequests < 1) throw new Error("invalid_rate_limit");
    if (!Number.isFinite(this.#windowMs) || this.#windowMs <= 0) throw new Error("invalid_rate_limit_window");
    if (!Number.isInteger(this.#burst) || this.#burst < 1) throw new Error("invalid_rate_limit_burst");
    if (!Number.isFinite(this.#burstWindowMs) || this.#burstWindowMs <= 0) throw new Error("invalid_rate_limit_burst_window");
  }

  consume(key: string): RateLimitDecision {
    const now = this.#now();
    const timestamps = (this.#requests.get(key) ?? []).filter((stamp) => stamp > now - this.#windowMs);
    const burstTimestamps = timestamps.filter((stamp) => stamp > now - this.#burstWindowMs);
    if (timestamps.length >= this.#maxRequests || burstTimestamps.length >= this.#burst) {
      const reset = timestamps.length >= this.#maxRequests
        ? (timestamps[0] ?? now) + this.#windowMs
        : (burstTimestamps[0] ?? now) + this.#burstWindowMs;
      const retry = Math.max(1, Math.ceil((reset - now) / 1000));
      this.#requests.set(key, timestamps);
      return { allowed: false, remaining: 0, retry_after_seconds: retry };
    }
    timestamps.push(now);
    this.#requests.set(key, timestamps);
    return { allowed: true, remaining: Math.max(0, this.#maxRequests - timestamps.length), retry_after_seconds: 0 };
  }

  assertAllowed(key: string): RateLimitDecision {
    const decision = this.consume(key);
    if (!decision.allowed) {
      throw new ProducerServiceError("rate_limited", "producer request rate limit exceeded", { retry_after_seconds: decision.retry_after_seconds });
    }
    return decision;
  }

  clear(key?: string): void {
    if (key === undefined) this.#requests.clear();
    else this.#requests.delete(key);
  }

  get max_requests_per_minute(): number { return this.#maxRequests; }
  get burst(): number { return this.#burst; }
  get burst_window_ms(): number { return this.#burstWindowMs; }
}

function resolveSecurityPolicy(overrides: Partial<SecurityPolicy> = {}): SecurityPolicy {
  const policy: SecurityPolicy = { ...DEFAULT_SECURITY_POLICY, ...overrides };
  if (overrides.on_quarantine === undefined) delete policy.on_quarantine;
  return policy;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null
    && typeof value === "object"
    && !nodeTypes.isProxy(value)
    && !Array.isArray(value);
}

function normalizedFieldName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/gu, "");
}

const SECRET_FIELD_NAMES = new Set([
  "password", "passwd", "secret", "token", "accesstoken", "refreshtoken", "apikey", "privatekey", "clientsecret", "authorization", "cookie", "setcookie", "auth", "authentication", "credential", "credentials", "credentialrequirement", "authenticationrequirement",
]);

const REQUIREMENT_DESCRIPTOR_KEYS = ["classification", "kind", "required", "value_included"] as const;
const REQUIREMENT_KIND = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/u;

/**
 * Credential-shaped fields may carry an eligibility requirement, but never a
 * credential value.  The descriptor is intentionally closed so adding a
 * value, nested object, accessor, or hidden property cannot become a new
 * transport for secrets.
 */
function isRequirementOnlyCredentialDescriptor(value: unknown): boolean {
  if (nodeTypes.isProxy(value)) return false;
  if (!isRecord(value)) return false;
  let keys: PropertyKey[];
  try {
    keys = Reflect.ownKeys(value);
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return false;
  } catch {
    return false;
  }
  if (keys.length !== REQUIREMENT_DESCRIPTOR_KEYS.length || keys.some((key) => typeof key !== "string")) return false;
  const expected = new Set<string>(REQUIREMENT_DESCRIPTOR_KEYS);
  if (keys.some((key) => !expected.has(key as string))) return false;
  for (const key of REQUIREMENT_DESCRIPTOR_KEYS) {
    let descriptor: PropertyDescriptor | undefined;
    try { descriptor = Object.getOwnPropertyDescriptor(value, key); } catch { return false; }
    if (!descriptor || descriptor.enumerable !== true || !("value" in descriptor)) return false;
  }
  const descriptor = value as Record<string, unknown>;
  return descriptor.classification === "requirement_only"
    && typeof descriptor.kind === "string"
    && REQUIREMENT_KIND.test(descriptor.kind)
    && typeof descriptor.required === "boolean"
    && descriptor.value_included === false;
}

function isArrayIndexKey(key: string, length: number): boolean {
  if (!/^(?:0|[1-9][0-9]*)$/u.test(key)) return false;
  const index = Number(key);
  return Number.isSafeInteger(index) && index >= 0 && index < length;
}

/**
 * JSON protocol values must expose only enumerable data properties.  Checking
 * descriptors before reading values keeps getters/non-enumerables out of the
 * security walk; structuredClone below additionally rejects reachable Proxy
 * objects before they can be persisted.
 */
function findUnsafeProperty(value: unknown, path = "$", seen = new WeakSet<object>()): string | null {
  if (value === null || typeof value !== "object") return null;
  if (nodeTypes.isProxy(value)) return path;
  if (seen.has(value)) return `${path}.__cycle`;
  seen.add(value);

  try {
    const array = Array.isArray(value);
    let prototype: object | null;
    try { prototype = Object.getPrototypeOf(value); } catch { return path; }
    if (array
      ? prototype !== Array.prototype
      : prototype !== Object.prototype && prototype !== null) return path;

    let keys: PropertyKey[];
    try { keys = Reflect.ownKeys(value); } catch { return path; }
    const arrayIndices: number[] = [];
    for (const key of keys) {
      if (array && key === "length") continue;
      if (typeof key !== "string") return `${path}.${String(key)}`;
      if (array) {
        const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
        if (
          !lengthDescriptor
          || !("value" in lengthDescriptor)
          || typeof lengthDescriptor.value !== "number"
          || !Number.isSafeInteger(lengthDescriptor.value)
        ) return `${path}.length`;
        if (!isArrayIndexKey(key, lengthDescriptor.value)) return `${path}.${key}`;
        arrayIndices.push(Number(key));
      }
      let descriptor: PropertyDescriptor | undefined;
      try { descriptor = Object.getOwnPropertyDescriptor(value, key); } catch { return `${path}.${key}`; }
      if (!descriptor || descriptor.enumerable !== true || !("value" in descriptor)) return `${path}.${key}`;
      const childPath = array ? `${path}[${key}]` : `${path}.${key}`;
      const unsafe = findUnsafeProperty(descriptor.value, childPath, seen);
      if (unsafe) return unsafe;
    }
    if (array) {
      const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
      const length = lengthDescriptor && "value" in lengthDescriptor && typeof lengthDescriptor.value === "number"
        ? lengthDescriptor.value
        : -1;
      if (arrayIndices.length !== length) return `${path}.__sparse`;
      arrayIndices.sort((left, right) => left - right);
      for (let index = 0; index < arrayIndices.length; index += 1) {
        if (arrayIndices[index] !== index) return `${path}.__sparse`;
      }
    }
    return null;
  } finally {
    seen.delete(value);
  }
}

function looksLikeSecretField(name: string): boolean {
  const normalized = normalizedFieldName(name);
  return SECRET_FIELD_NAMES.has(normalized) || /(?:token|secret|password|passwd|apikey|privatekey|authorization|cookie|credential)$/u.test(normalized);
}

function findSecretField(value: unknown, path = "$"): string | null {
  if (nodeTypes.isProxy(value)) return path;
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const found = findSecretField(value[index], `${path}[${index}]`);
      if (found) return found;
    }
    return null;
  }
  if (!isRecord(value)) return null;
  for (const [key, child] of Object.entries(value)) {
    if (["contains_secrets", "contains_personal_data", "security_flags"].includes(key)) continue;
    const childPath = `${path}.${key}`;
    if (looksLikeSecretField(key)) {
      if (isRequirementOnlyCredentialDescriptor(child)) continue;
      return childPath;
    }
    const found = findSecretField(child, childPath);
    if (found) return found;
  }
  return null;
}

function looksLikeSecretValue(value: string): boolean {
  return /\b(?:password|passwd|secret|api[ _-]?key|token|authorization)\s*[:=]\s*\S+/iu.test(value);
}

function walkStringValues(value: unknown, callback: (value: string, path: string) => void, path = "$"): void {
  if (typeof value === "string") {
    callback(value, path);
    return;
  }
  if (nodeTypes.isProxy(value)) return;
  if (Array.isArray(value)) {
    value.forEach((child, index) => walkStringValues(child, callback, `${path}[${index}]`));
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, child] of Object.entries(value)) walkStringValues(child, callback, `${path}.${key}`);
}

function jsonBytes(value: unknown): number {
  try { return Buffer.byteLength(JSON.stringify(value), "utf8"); } catch { return Number.POSITIVE_INFINITY; }
}

function emitQuarantine(policy: SecurityPolicy, event: QuarantineEvent): void {
  if (!policy.on_quarantine) return;
  try {
    policy.on_quarantine(event);
  } catch {
    throw new ProducerServiceError("storage_error", "quarantine hook failed", { status: 500 });
  }
}

function rejectUnsafeRepresentation(value: unknown, policy: SecurityPolicy, runId?: string): void {
  const unsafePath = findUnsafeProperty(value);
  if (unsafePath === null) return;
  emitQuarantine(policy, { kind: "payload", reason: "secret_field", ...(runId === undefined ? {} : { run_id: runId }), field_path: unsafePath });
  throw new ProducerServiceError("secret_field_rejected", "payload contains a secret-bearing field");
}

function securityCheck(value: unknown, policy: SecurityPolicy, runId?: string): void {
  rejectUnsafeRepresentation(value, policy, runId);
  // A Proxy can present ordinary-looking descriptors while still intercepting
  // reads.  Node's structured clone rejects Proxy values without invoking the
  // target, so reject the whole payload before any persistence call.
  try { structuredClone(value); } catch {
    emitQuarantine(policy, { kind: "payload", reason: "secret_field", ...(runId === undefined ? {} : { run_id: runId }), field_path: "$" });
    if (policy.reject_secrets) throw new ProducerServiceError("secret_field_rejected", "payload contains a secret-bearing field");
  }
  const secretField = findSecretField(value);
  if (secretField) {
    emitQuarantine(policy, { kind: "payload", reason: "secret_field", ...(runId === undefined ? {} : { run_id: runId }), field_path: secretField });
    if (policy.reject_secrets) throw new ProducerServiceError("secret_field_rejected", "payload contains a secret-bearing field");
  }
  walkStringValues(value, (text, path) => {
    if (looksLikeSecretValue(text)) {
      emitQuarantine(policy, { kind: "payload", reason: "secret_field", ...(runId === undefined ? {} : { run_id: runId }), field_path: path });
      if (policy.reject_secrets) throw new ProducerServiceError("secret_field_rejected", "payload contains a secret-like value");
    }
  });
}

function securityCheckBatch(input: SubmitBatchRequest, policy: SecurityPolicy): void {
  if (input.findings.length > policy.max_findings_per_batch || input.evidence.length > policy.max_evidence_per_batch) {
    throw new ProducerServiceError("batch_limit_exceeded", "batch item limit exceeded");
  }
  for (const evidence of input.evidence) {
    if (evidence.excerpt !== null && Array.from(evidence.excerpt).length > policy.max_evidence_excerpt_characters) {
      throw new ProducerServiceError("evidence_excerpt_too_large", "evidence excerpt is too large");
    }
    if (jsonBytes(evidence.metadata) > policy.max_evidence_metadata_bytes) {
      throw new ProducerServiceError("evidence_metadata_too_large", "evidence metadata is too large");
    }
    if (evidence.handling.contains_secrets) {
      emitQuarantine(policy, { kind: "evidence", reason: "secret_bearing_evidence", evidence_id: evidence.evidence_id, run_id: input.run_id });
      if (policy.reject_secrets) throw new ProducerServiceError("secret_bearing_evidence_rejected", "evidence is marked as containing secrets");
    }
    if (evidence.handling.contains_personal_data) {
      emitQuarantine(policy, { kind: "evidence", reason: "personal_data", evidence_id: evidence.evidence_id, run_id: input.run_id });
      if (policy.reject_personal_data) throw new ProducerServiceError("personal_data_rejected", "evidence is marked as containing personal data");
    }
  }
  for (const finding of input.findings) {
    if (finding.security_flags.length > 0 && policy.quarantine_hostile_findings) {
      emitQuarantine(policy, { kind: "finding", reason: "security_flag", finding_id: finding.finding_id, flags: finding.security_flags, run_id: input.run_id });
    }
  }
}

function allowedStream(principal: ProducerPrincipal, streamId: string): boolean {
  return principal.allowed_stream_ids.includes(streamId);
}

function assertBeginScope(principal: ProducerPrincipal, input: BeginRunRequest): void {
  if (!allowedStream(principal, input.stream_id)) throw new ProducerServiceError("unauthorized_stream", "producer is not authorized for this stream");
  if (principal.producer_id !== input.producer.producer_id) throw new ProducerServiceError("unauthorized_producer", "producer identity does not match credential");
}

function bodyRunId(value: unknown): string | null {
  if (!isRecord(value)) return null;
  return typeof value.run_id === "string" ? value.run_id : null;
}

function mapPersistenceError(error: unknown): ProducerServiceError {
  if (error instanceof ProducerServiceError) return error;
  if (isRecord(error) && typeof error.code === "string" && PERSISTENCE_ERROR_CODES.has(error.code as PersistenceErrorCode)) {
    const code = error.code as PersistenceErrorCode;
    return new ProducerServiceError(code, code, { status: statusForProducerError(code) });
  }
  return new ProducerServiceError("storage_error", "database operation failed", { status: 503 });
}

/**
 * Application policy for producer lifecycle operations. It deliberately knows
 * nothing about SQL or HTTP; the only storage dependency is the public
 * persistence boundary injected at construction time.
 */
export class ProducerService {
  readonly persistence: ProducerPersistence;
  readonly authenticator: ProducerAuthenticator;
  readonly rate_limiter: {
    assertAllowed(key: string): RateLimitDecision;
    max_requests_per_minute: number;
    burst: number;
    burst_window_ms: number;
  };
  readonly security: SecurityPolicy;
  readonly validator: ProtocolValidator;
  readonly #now: () => Date;

  constructor(options: ProducerServiceOptions & { validator?: ProtocolValidator }) {
    this.persistence = options.persistence;
    this.authenticator = options.authenticator;
    this.rate_limiter = options.rate_limiter ?? new ProducerRateLimiter(options.rate_limit);
    this.security = resolveSecurityPolicy(options.security);
    this.validator = options.validator ?? defaultProtocolValidator;
    this.#now = options.now ?? (() => new Date());
  }

  authenticate(request: ProducerAuthenticationRequest): ProducerPrincipal {
    const principal = this.authenticator.authenticate(request);
    if (!principal) throw new ProducerServiceError("unauthorized", "valid bearer credentials are required");
    return principal;
  }

  assertRateAllowed(principal: ProducerPrincipal): RateLimitDecision {
    return this.rate_limiter.assertAllowed(`${principal.tenant_id}:${principal.producer_id}`);
  }

  async beginRun(value: unknown, principal: ProducerPrincipal): Promise<RunRecord> {
    return this.beginRunInternal(value, principal);
  }

  /**
   * Durable local-file/import adapter entrypoint. Protocol run bundles carry
   * producer-visible string IDs that are not required to be UUIDs. The
   * PostgreSQL adapter stores that wire ID separately from its UUID relational
   * key (migration 0003), so importing a bundle does not silently rewrite its
   * identity. The public REST begin route intentionally uses beginRun and
   * lets the database generate an ID when the wire contract omits one.
   */
  async beginRunWithWireId(wireRunId: string, value: unknown, principal: ProducerPrincipal): Promise<RunRecord> {
    if (wireRunId.length < 8 || wireRunId.length > 512) throw new ProducerServiceError("invalid_input", "wire run_id must be between 8 and 512 characters");
    return this.beginRunInternal(value, principal, wireRunId);
  }

  private async beginRunInternal(value: unknown, principal: ProducerPrincipal, wireRunId?: string): Promise<RunRecord> {
    rejectUnsafeRepresentation(value, this.security);
    let input: BeginRunRequest;
    try { input = this.validator.begin(value); } catch (error) { throw mapPersistenceError(error); }
    assertBeginScope(principal, input);
    securityCheck(input, this.security);
    try {
      return await this.persistence.beginRun({ ...input, tenant_id: principal.tenant_id, ...(wireRunId === undefined ? {} : { run_id: wireRunId }) });
    } catch (error) {
      throw mapPersistenceError(error);
    }
  }

  async submitBatch(runId: string, value: unknown, principal: ProducerPrincipal): Promise<RunRecord> {
    rejectUnsafeRepresentation(value, this.security, runId);
    const bodyId = bodyRunId(value);
    if (bodyId !== null && bodyId !== runId) throw new ProducerServiceError("invalid_input", "path run_id and body run_id must match");
    // Scope the path before full body/schema processing. This prevents a
    // foreign producer from learning whether a run exists via a malformed
    // batch and keeps cross-tenant requests at the scoped 404 boundary.
    const run = await this.scopedRun(runId, principal);
    let input: SubmitBatchRequest;
    try { input = this.validator.submit(value); } catch (error) { throw mapPersistenceError(error); }
    if (input.run_id !== runId) throw new ProducerServiceError("invalid_input", "path run_id and body run_id must match");
    securityCheck(input, this.security, runId);
    securityCheckBatch(input, this.security);
    try {
      return await this.persistence.submitBatch({ ...input, tenant_id: principal.tenant_id });
    } catch (error) {
      throw mapPersistenceError(error);
    }
  }

  async completeRun(runId: string, value: unknown, principal: ProducerPrincipal): Promise<RunRecord> {
    rejectUnsafeRepresentation(value, this.security, runId);
    const bodyId = bodyRunId(value);
    if (bodyId !== null && bodyId !== runId) throw new ProducerServiceError("invalid_input", "path run_id and body run_id must match");
    await this.scopedRun(runId, principal);
    let input: CompleteRunRequest;
    try { input = this.validator.complete(value); } catch (error) { throw mapPersistenceError(error); }
    if (input.run_id !== runId) throw new ProducerServiceError("invalid_input", "path run_id and body run_id must match");
    securityCheck(input, this.security, runId);
    try {
      return await this.persistence.completeRun({ ...input, tenant_id: principal.tenant_id });
    } catch (error) {
      throw mapPersistenceError(error);
    }
  }

  async getRun(runId: string, principal: ProducerPrincipal): Promise<RunRecord> {
    return this.scopedRun(runId, principal);
  }

  async getFindings(runId: string, principal: ProducerPrincipal): Promise<RunRecord["findings"]> {
    const run = await this.scopedRun(runId, principal);
    return run.findings;
  }

  /** Used by readiness checks; it does not expose a database-specific API. */
  async readiness(): Promise<{ ok: boolean; checked_at: string }> {
    try {
      // Connectivity belongs to the injected adapter. In-memory test doubles
      // may omit the optional probe; the application service never issues SQL.
      if (this.persistence.checkReady) await this.persistence.checkReady();
      return { ok: true, checked_at: this.#now().toISOString() };
    } catch {
      return { ok: false, checked_at: this.#now().toISOString() };
    }
  }

  private async scopedRun(runId: string, principal: ProducerPrincipal): Promise<RunRecord> {
    let run: RunRecord | null;
    try {
      run = await this.persistence.getRunForTenant(principal.tenant_id, runId);
    } catch (error) {
      throw mapPersistenceError(error);
    }
    // Deliberately collapse tenant, producer, and stream mismatches into the
    // same 404. The persistence query is already tenant-scoped; producer and
    // stream checks complete the authorization boundary without an unscoped
    // fallback that could be accidentally reused by another adapter.
    if (!run
      || run.tenant_id !== principal.tenant_id
      || run.producer_id !== principal.producer_id
      || !allowedStream(principal, run.stream_id)) {
      throw new ProducerServiceError("run_not_found", "run was not found");
    }
    return run;
  }
}
