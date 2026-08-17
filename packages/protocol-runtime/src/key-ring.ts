import { REPLAY_WINDOW_SECONDS, verifyRawBody } from "./crypto.ts";

export const KEY_ROTATION_OVERLAP_SECONDS = 24 * 60 * 60;

export interface SigningKey {
  keyId: string;
  secret: string;
  /** Inclusive Unix second at which the key becomes valid. Defaults to 0. */
  activeFrom?: number;
  /** Exclusive Unix second at which the key stops being valid. */
  expiresAt?: number;
}

export interface KeyMetadata {
  keyId: string;
  activeFrom: number;
  expiresAt: number | null;
}

export interface ResolvedSigningKey extends KeyMetadata {
  secret: string;
}

export interface KeyRingOptions {
  overlapSeconds?: number;
}

function assertKeyId(keyId: string): void {
  if (!/^[A-Za-z0-9._-]{1,128}$/u.test(keyId)) throw new TypeError("invalid_key_id");
}

function assertTimestamp(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`invalid_${field}`);
}

function assertKey(key: SigningKey): void {
  assertKeyId(key.keyId);
  if (key.secret.length === 0) throw new TypeError("signing_secret_required");
  const activeFrom = key.activeFrom ?? 0;
  assertTimestamp(activeFrom, "key_active_from");
  if (key.expiresAt !== undefined) {
    assertTimestamp(key.expiresAt, "key_expires_at");
    if (key.expiresAt <= activeFrom) throw new TypeError("key_expiry_before_activation");
  }
}

function isValidAt(key: SigningKey, timestampSeconds: number): boolean {
  const activeFrom = key.activeFrom ?? 0;
  return activeFrom <= timestampSeconds && (key.expiresAt === undefined || timestampSeconds < key.expiresAt);
}

function metadata(key: SigningKey): KeyMetadata {
  return {
    keyId: key.keyId,
    activeFrom: key.activeFrom ?? 0,
    expiresAt: key.expiresAt ?? null,
  };
}

/**
 * In-memory key ring abstraction. Production callers should populate it from
 * a secret manager; `describe()` intentionally never returns key material.
 */
export class KeyRing {
  readonly #overlapSeconds: number;
  readonly #keys = new Map<string, SigningKey>();

  constructor(keys: readonly SigningKey[] = [], options: KeyRingOptions = {}) {
    const overlapSeconds = options.overlapSeconds ?? KEY_ROTATION_OVERLAP_SECONDS;
    if (!Number.isSafeInteger(overlapSeconds) || overlapSeconds < 0) {
      throw new TypeError("invalid_key_rotation_overlap_seconds");
    }
    this.#overlapSeconds = overlapSeconds;
    for (const key of keys) this.add(key);
  }

  get overlapSeconds(): number {
    return this.#overlapSeconds;
  }

  add(key: SigningKey): void {
    assertKey(key);
    if (this.#keys.has(key.keyId)) throw new Error(`duplicate_key_id:${key.keyId}`);
    this.#keys.set(key.keyId, { ...key });
  }

  /**
   * Activates a new key and expires every currently valid predecessor no later
   * than the configured overlap deadline. Intervals are [activeFrom, expiresAt).
   */
  rotate(key: Omit<SigningKey, "activeFrom" | "expiresAt"> & { activeFrom?: number }, activatedAt: number): void {
    assertTimestamp(activatedAt, "rotation_timestamp");
    const activeFrom = key.activeFrom ?? activatedAt;
    if (activeFrom !== activatedAt) throw new TypeError("rotation_activation_mismatch");
    if (this.#keys.has(key.keyId)) throw new Error(`duplicate_key_id:${key.keyId}`);
    const overlapExpiry = activatedAt + this.#overlapSeconds;
    for (const [keyId, existing] of this.#keys.entries()) {
      if (!isValidAt(existing, activatedAt)) continue;
      const expiresAt = existing.expiresAt === undefined
        ? overlapExpiry
        : Math.min(existing.expiresAt, overlapExpiry);
      this.#keys.set(keyId, { ...existing, expiresAt });
    }
    this.add({ ...key, activeFrom });
  }

  describe(): readonly KeyMetadata[] {
    return [...this.#keys.values()]
      .map(metadata)
      .sort((left, right) => left.keyId < right.keyId ? -1 : left.keyId > right.keyId ? 1 : 0);
  }

  getForSigning(timestampSeconds: number, keyId?: string): ResolvedSigningKey {
    assertTimestamp(timestampSeconds, "timestamp_seconds");
    const selected = keyId === undefined
      ? [...this.#keys.values()]
        .filter((key) => isValidAt(key, timestampSeconds))
        .sort((left, right) => {
          const leftActive = left.activeFrom ?? 0;
          const rightActive = right.activeFrom ?? 0;
          if (leftActive !== rightActive) return rightActive - leftActive;
          return left.keyId < right.keyId ? -1 : left.keyId > right.keyId ? 1 : 0;
        })[0]
      : this.#keys.get(keyId);
    if (!selected || !isValidAt(selected, timestampSeconds)) throw new Error("no_valid_signing_key");
    return { ...metadata(selected), secret: selected.secret };
  }

  verify(
    rawBody: string,
    timestampSeconds: number,
    signatureHex: string,
    keyId: string,
    options: { nowSeconds?: number; replayWindowSeconds?: number } = {},
  ): boolean {
    const nowSeconds = options.nowSeconds ?? Math.floor(Date.now() / 1000);
    const replayWindowSeconds = options.replayWindowSeconds ?? REPLAY_WINDOW_SECONDS;
    const key = this.#keys.get(keyId);
    if (!key || !isValidAt(key, timestampSeconds) || !isValidAt(key, nowSeconds)) return false;
    return verifyRawBody(rawBody, timestampSeconds, signatureHex, key.secret, {
      nowSeconds,
      replayWindowSeconds,
    });
  }
}

