import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export const SECURITY_DEFAULTS = Object.freeze({
  algorithm: "hmac-sha256",
  replayWindowSeconds: 300,
  maxBodyBytes: 1024 * 1024,
  maxFindingsPerBatch: 100,
  maxEvidencePerBatch: 100,
  maxEvidenceExcerptCharacters: 4000,
  maxEvidenceMetadataBytes: 64 * 1024,
  keyRotationOverlapHours: 24,
  producerRequestsPerMinute: 60,
  producerBurst: 10,
});

export type SecurityErrorCode =
  | "unauthorized"
  | "unauthorized_stream"
  | "unauthorized_producer"
  | "credential_expired"
  | "body_too_large"
  | "batch_limit_exceeded"
  | "evidence_excerpt_too_large"
  | "evidence_metadata_too_large"
  | "secret_bearing_evidence_rejected"
  | "secret_field_rejected"
  | "personal_data_rejected"
  | "quarantine_hook_failed"
  | "rate_limited";

const SECURITY_ERROR_STATUS: Record<SecurityErrorCode, number> = {
  unauthorized: 401,
  unauthorized_stream: 403,
  unauthorized_producer: 403,
  credential_expired: 401,
  body_too_large: 413,
  batch_limit_exceeded: 413,
  evidence_excerpt_too_large: 413,
  evidence_metadata_too_large: 413,
  secret_bearing_evidence_rejected: 422,
  secret_field_rejected: 422,
  personal_data_rejected: 422,
  quarantine_hook_failed: 500,
  rate_limited: 429,
};

/** An error that can be mapped to a stable transport-level error class. */
export class SecurityError extends Error {
  readonly code: SecurityErrorCode;
  readonly status: number;
  readonly retryAfterSeconds: number | null;

  constructor(
    code: SecurityErrorCode,
    detail?: string,
    options: { retryAfterSeconds?: number } = {},
  ) {
    super(detail ? `${code}:${detail}` : code);
    this.name = "SecurityError";
    this.code = code;
    this.status = SECURITY_ERROR_STATUS[code];
    this.retryAfterSeconds = options.retryAfterSeconds ?? null;
  }
}

export interface ProducerCredential {
  producerId: string;
  secret: string;
  allowedStreamIds: readonly string[];
  credentialId?: string;
  /** An expired credential is rejected even when its secret matches. */
  expiresAt?: string | number | Date;
}

export interface ProducerPrincipal {
  producerId: string;
  allowedStreamIds: readonly string[];
  credentialId?: string;
}

export interface ProducerAuthenticationRequest {
  authorization?: string;
  nowSeconds?: number;
}

export interface ProducerAuthenticator {
  authenticate(request: ProducerAuthenticationRequest): ProducerPrincipal | null;
}

function bearerSecret(authorization: string | undefined): string | null {
  if (!authorization) return null;
  const match = /^Bearer[ \t]+([^ \t]+)[ \t]*$/i.exec(authorization);
  return match?.[1] ?? null;
}

function credentialDigest(secret: string): Buffer {
  return createHash("sha256").update(secret, "utf8").digest();
}

/**
 * Compares secrets without an early length-dependent return. Hashing both
 * operands first also makes this safe for bearer tokens of different lengths.
 */
export function constantTimeEqual(left: string | Buffer, right: string | Buffer): boolean {
  const leftDigest = createHash("sha256").update(left).digest();
  const rightDigest = createHash("sha256").update(right).digest();
  return timingSafeEqual(leftDigest, rightDigest);
}

function expirySeconds(value: ProducerCredential["expiresAt"]): number | null {
  if (value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : Number.NaN;
  if (value instanceof Date) return value.getTime() / 1000;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? Number.NaN : parsed / 1000;
}

/**
 * In-memory producer credential verifier used by the prototype and adapters.
 * Production deployments can implement the same interface against a secret
 * manager without changing the HTTP service or importer.
 */
export class StaticProducerAuthenticator implements ProducerAuthenticator {
  readonly #credentials: readonly (ProducerCredential & { digest: Buffer })[];

  constructor(credentials: readonly ProducerCredential[]) {
    if (credentials.length === 0) throw new Error("at_least_one_producer_credential_required");
    this.#credentials = credentials.map((credential) => {
      if (!credential.producerId || !credential.secret || credential.allowedStreamIds.length === 0) {
        throw new Error("invalid_producer_credential");
      }
      return { ...credential, digest: credentialDigest(credential.secret) };
    });
  }

  authenticate(request: ProducerAuthenticationRequest): ProducerPrincipal | null {
    const presented = bearerSecret(request.authorization);
    if (!presented) return null;
    const presentedDigest = credentialDigest(presented);
    const nowSeconds = request.nowSeconds ?? Math.floor(Date.now() / 1000);
    let match: (ProducerCredential & { digest: Buffer }) | null = null;
    let expiredMatch = false;

    // Do not return on the first match: every configured credential receives a
    // constant-time comparison, regardless of which producer it belongs to.
    for (const credential of this.#credentials) {
      const equal = timingSafeEqual(presentedDigest, credential.digest);
      if (equal && match === null) {
        match = credential;
        const expires = expirySeconds(credential.expiresAt);
        expiredMatch = expires !== null && (!Number.isFinite(expires) || nowSeconds >= expires);
      }
    }
    if (!match || expiredMatch) return null;
    const principal: ProducerPrincipal = {
      producerId: match.producerId,
      allowedStreamIds: [...match.allowedStreamIds],
    };
    if (match.credentialId !== undefined) principal.credentialId = match.credentialId;
    return principal;
  }
}

/** Backwards-compatible helper for the prototype's single-token server mode. */
export function legacyTokenAuthenticator(token: string): ProducerAuthenticator {
  return new StaticProducerAuthenticator([
    { producerId: "*", secret: token, allowedStreamIds: ["*"] },
  ]);
}

export interface RateLimitOptions {
  maxRequestsPerMinute?: number;
  windowMs?: number;
  /** Maximum requests in the short burst window; defaults to the pinned 10. */
  burst?: number;
  burstWindowMs?: number;
  now?: () => number;
}

export interface RateLimitDecision {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

/** A process-local sliding-window limiter keyed by authenticated producer ID. */
export class ProducerRateLimiter {
  readonly #maxRequests: number;
  readonly #windowMs: number;
  readonly #burst: number;
  readonly #burstWindowMs: number;
  readonly #now: () => number;
  readonly #requests = new Map<string, number[]>();

  constructor(options: RateLimitOptions = {}) {
    this.#maxRequests = options.maxRequestsPerMinute ?? SECURITY_DEFAULTS.producerRequestsPerMinute;
    this.#windowMs = options.windowMs ?? 60_000;
    this.#burst = options.burst ?? SECURITY_DEFAULTS.producerBurst;
    this.#burstWindowMs = options.burstWindowMs ?? 1_000;
    this.#now = options.now ?? (() => Date.now());
    if (!Number.isInteger(this.#maxRequests) || this.#maxRequests < 1) {
      throw new Error("invalid_rate_limit");
    }
    if (!Number.isFinite(this.#windowMs) || this.#windowMs <= 0) throw new Error("invalid_rate_limit_window");
    if (!Number.isInteger(this.#burst) || this.#burst < 1) throw new Error("invalid_rate_limit_burst");
    if (!Number.isFinite(this.#burstWindowMs) || this.#burstWindowMs <= 0) throw new Error("invalid_rate_limit_burst_window");
  }

  consume(producerId: string): RateLimitDecision {
    const now = this.#now();
    const cutoff = now - this.#windowMs;
    const timestamps = (this.#requests.get(producerId) ?? []).filter((timestamp) => timestamp > cutoff);
    const burstCutoff = now - this.#burstWindowMs;
    const burstTimestamps = timestamps.filter((timestamp) => timestamp > burstCutoff);
    if (timestamps.length >= this.#maxRequests || burstTimestamps.length >= this.#burst) {
      const windowStart = timestamps.length >= this.#maxRequests
        ? (timestamps[0] ?? now) + this.#windowMs
        : (burstTimestamps[0] ?? now) + this.#burstWindowMs;
      const retryAfterSeconds = Math.max(1, Math.ceil((windowStart - now) / 1000));
      this.#requests.set(producerId, timestamps);
      return { allowed: false, remaining: 0, retryAfterSeconds };
    }
    timestamps.push(now);
    this.#requests.set(producerId, timestamps);
    return {
      allowed: true,
      remaining: Math.max(0, this.#maxRequests - timestamps.length),
      retryAfterSeconds: 0,
    };
  }

  assertAllowed(producerId: string): RateLimitDecision {
    const decision = this.consume(producerId);
    if (!decision.allowed) {
      throw new SecurityError("rate_limited", undefined, {
        retryAfterSeconds: decision.retryAfterSeconds,
      });
    }
    return decision;
  }

  get maxRequestsPerMinute(): number { return this.#maxRequests; }
  get burst(): number { return this.#burst; }
  get burstWindowMs(): number { return this.#burstWindowMs; }

  clear(producerId?: string): void {
    if (producerId === undefined) this.#requests.clear();
    else this.#requests.delete(producerId);
  }
}

export interface QuarantineEvent {
  kind: "evidence" | "finding" | "payload";
  reason:
    | "secret_bearing_evidence"
    | "secret_field"
    | "personal_data"
    | "security_flag";
  runId?: string;
  evidenceId?: string;
  findingId?: string;
  flags?: readonly string[];
  fieldPath?: string;
}

export type QuarantineHook = (event: QuarantineEvent) => void;

export interface SecurityPolicy {
  maxBodyBytes: number;
  maxFindingsPerBatch: number;
  maxEvidencePerBatch: number;
  maxEvidenceExcerptCharacters: number;
  maxEvidenceMetadataBytes: number;
  rejectSecrets: boolean;
  rejectPersonalData: boolean;
  quarantinePersonalData: boolean;
  quarantineHostileFindings: boolean;
  onQuarantine?: QuarantineHook;
}

export const DEFAULT_SECURITY_POLICY: SecurityPolicy = Object.freeze({
  maxBodyBytes: SECURITY_DEFAULTS.maxBodyBytes,
  maxFindingsPerBatch: SECURITY_DEFAULTS.maxFindingsPerBatch,
  maxEvidencePerBatch: SECURITY_DEFAULTS.maxEvidencePerBatch,
  maxEvidenceExcerptCharacters: SECURITY_DEFAULTS.maxEvidenceExcerptCharacters,
  maxEvidenceMetadataBytes: SECURITY_DEFAULTS.maxEvidenceMetadataBytes,
  rejectSecrets: true,
  rejectPersonalData: false,
  quarantinePersonalData: true,
  quarantineHostileFindings: true,
});

export function resolveSecurityPolicy(overrides: Partial<SecurityPolicy> = {}): SecurityPolicy {
  const policy: SecurityPolicy = {
    ...DEFAULT_SECURITY_POLICY,
    ...overrides,
  };
  if (overrides.onQuarantine === undefined) delete policy.onQuarantine;
  return policy;
}

function safeJsonBytes(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value), "utf8");
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function normalizedFieldName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

const SECRET_FIELD_NAMES = new Set([
  "password",
  "passwd",
  "secret",
  "token",
  "accesstoken",
  "refreshtoken",
  "apikey",
  "privatekey",
  "clientsecret",
  "authorization",
  "cookie",
  "setcookie",
  "credential",
  "credentials",
]);

function looksLikeSecretField(name: string): boolean {
  const normalized = normalizedFieldName(name);
  if (SECRET_FIELD_NAMES.has(normalized)) return true;
  return /(?:token|secret|password|passwd|apikey|privatekey|authorization|cookie|credential)$/.test(normalized);
}

/** Returns the first suspicious object key without returning its value. */
export function findSecretField(value: unknown, path = "$"): string | null {
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const found = findSecretField(value[index], `${path}[${index}]`);
      if (found) return found;
    }
    return null;
  }
  if (!value || typeof value !== "object") return null;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    // These are explicit handling/security declarations, not secret values.
    if (["contains_secrets", "contains_personal_data", "security_flags"].includes(key)) continue;
    const childPath = `${path}.${key}`;
    if (looksLikeSecretField(key)) return childPath;
    const found = findSecretField(child, childPath);
    if (found) return found;
  }
  return null;
}

function looksLikeSecretValue(value: string): boolean {
  return (
    /\b(?:password|passwd|secret|api[ _-]?key|token|authorization)\s*[:=]\s*\S+/i.test(value) ||
    /\bAKIA[0-9A-Z]{16}\b/.test(value) ||
    /\bsk-[A-Za-z0-9]{16,}\b/.test(value) ||
    /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}\b/i.test(value)
  );
}

function notifyQuarantine(policy: SecurityPolicy, event: QuarantineEvent): void {
  if (!policy.onQuarantine) return;
  try {
    policy.onQuarantine(event);
  } catch {
    throw new SecurityError("quarantine_hook_failed");
  }
}

export function utf8CharacterCount(value: string): number {
  return Array.from(value).length;
}

export function enforceExcerptLimit(excerpt: string | null | undefined, policy: SecurityPolicy, evidenceId?: string): void {
  if (excerpt !== null && excerpt !== undefined && utf8CharacterCount(excerpt) > policy.maxEvidenceExcerptCharacters) {
    throw new SecurityError("evidence_excerpt_too_large", evidenceId);
  }
}

export function enforceBatchLimits(
  findings: readonly unknown[],
  evidence: readonly unknown[],
  policy: SecurityPolicy,
): void {
  if (
    findings.length > policy.maxFindingsPerBatch ||
    evidence.length > policy.maxEvidencePerBatch
  ) {
    throw new SecurityError("batch_limit_exceeded");
  }
}

export function enforceEvidenceSecurity(
  evidence: {
    evidenceId?: string;
    excerpt?: string | null;
    handling?: { containsSecrets?: boolean; containsPersonalData?: boolean };
    metadata?: unknown;
    [key: string]: unknown;
  },
  policy: SecurityPolicy,
  context: { runId?: string } = {},
): void {
  enforceExcerptLimit(evidence.excerpt, policy, evidence.evidenceId);
  if (evidence.metadata !== undefined && safeJsonBytes(evidence.metadata) > policy.maxEvidenceMetadataBytes) {
    throw new SecurityError("evidence_metadata_too_large", evidence.evidenceId);
  }

  const secretField = findSecretField(evidence);
  const flaggedSecret = evidence.handling?.containsSecrets === true;
  const probableSecretValue = Object.values(evidence).some(
    (value) => typeof value === "string" && looksLikeSecretValue(value),
  );
  if (flaggedSecret || secretField || probableSecretValue) {
    notifyQuarantine(policy, {
      kind: "evidence",
      reason: flaggedSecret ? "secret_bearing_evidence" : "secret_field",
      ...(context.runId === undefined ? {} : { runId: context.runId }),
      ...(evidence.evidenceId === undefined ? {} : { evidenceId: evidence.evidenceId }),
      ...(secretField === null ? {} : { fieldPath: secretField }),
    });
    if (policy.rejectSecrets) {
      throw new SecurityError(
        flaggedSecret ? "secret_bearing_evidence_rejected" : "secret_field_rejected",
        evidence.evidenceId,
      );
    }
  }

  if (evidence.handling?.containsPersonalData === true) {
    if (policy.quarantinePersonalData) {
      notifyQuarantine(policy, {
        kind: "evidence",
        reason: "personal_data",
        ...(context.runId === undefined ? {} : { runId: context.runId }),
        ...(evidence.evidenceId === undefined ? {} : { evidenceId: evidence.evidenceId }),
      });
    }
    if (policy.rejectPersonalData) throw new SecurityError("personal_data_rejected", evidence.evidenceId);
  }
}

export function enforceFindingSecurity(
  finding: { findingId?: string; securityFlags?: readonly string[]; [key: string]: unknown },
  policy: SecurityPolicy,
  context: { runId?: string } = {},
): void {
  const secretField = findSecretField(finding);
  if (secretField) {
    notifyQuarantine(policy, {
      kind: "finding",
      reason: "secret_field",
      ...(context.runId === undefined ? {} : { runId: context.runId }),
      ...(finding.findingId === undefined ? {} : { findingId: finding.findingId }),
      fieldPath: secretField,
    });
    if (policy.rejectSecrets) throw new SecurityError("secret_field_rejected", finding.findingId);
  }
  const flags = finding.securityFlags ?? [];
  if (flags.length > 0 && policy.quarantineHostileFindings) {
    notifyQuarantine(policy, {
      kind: "finding",
      reason: "security_flag",
      ...(context.runId === undefined ? {} : { runId: context.runId }),
      ...(finding.findingId === undefined ? {} : { findingId: finding.findingId }),
      flags: [...flags],
    });
  }
}

/** Stable JSON representation used for payload hashes and signatures. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function signBody(rawBody: string, timestampSeconds: number, secret: string): string {
  return createHmac("sha256", secret)
    .update(`${timestampSeconds}.${rawBody}`, "utf8")
    .digest("hex");
}

export function verifyBody(
  rawBody: string,
  timestampSeconds: number,
  signatureHex: string,
  secret: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): boolean {
  if (!Number.isInteger(timestampSeconds)) return false;
  if (Math.abs(nowSeconds - timestampSeconds) > SECURITY_DEFAULTS.replayWindowSeconds) return false;
  if (!/^[0-9a-f]{64}$/i.test(signatureHex)) return false;
  return constantTimeEqual(signBody(rawBody, timestampSeconds, secret), signatureHex);
}
