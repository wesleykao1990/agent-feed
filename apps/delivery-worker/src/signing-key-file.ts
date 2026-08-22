import { lstat, readFile } from "node:fs/promises";
import { KeyRing, type SigningKey } from "@agent-feed/protocol-runtime";
import type { DeliveryEndpoint } from "@agent-feed/delivery-core";
import type { DeliveryKeyResolver } from "./signer.ts";

const MAX_KEY_FILE_BYTES = 64 * 1024;
const KEY_REFERENCE_PATTERN = /^[A-Za-z0-9._-]{1,128}$/u;

/**
 * A local-development key file maps the opaque signing_secret_ref stored on a
 * subscription to one active signing key. The file is an operational secret
 * store, not part of the Agent Feed protocol and must remain private.
 */
export interface SigningKeyFileEntry {
  secret: string;
  active_from?: number;
  expires_at?: number;
}

export type SigningKeyFileDocument = Readonly<Record<string, SigningKeyFileEntry>>;

function invalidKeyFile(): Error {
  return new Error("signing_key_file_invalid");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function numberField(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw invalidKeyFile();
  return value as number;
}

function normalizeEntry(reference: string, value: unknown): SigningKey {
  if (!KEY_REFERENCE_PATTERN.test(reference) || !isPlainObject(value)) throw invalidKeyFile();
  const secret = value.secret;
  if (typeof secret !== "string" || secret.length === 0 || /[\r\n]/u.test(secret)) throw invalidKeyFile();
  const activeFrom = numberField(value.active_from);
  const expiresAt = numberField(value.expires_at);
  if (expiresAt !== undefined && expiresAt <= (activeFrom ?? 0)) throw invalidKeyFile();
  return {
    keyId: reference,
    secret,
    ...(activeFrom === undefined ? {} : { activeFrom }),
    ...(expiresAt === undefined ? {} : { expiresAt }),
  };
}

function parseDocument(value: unknown): SigningKeyFileDocument {
  if (!isPlainObject(value)) throw invalidKeyFile();
  const entries = Object.entries(value);
  if (entries.length === 0) throw invalidKeyFile();
  const result: Record<string, SigningKeyFileEntry> = {};
  for (const [reference, raw] of entries) {
    const key = normalizeEntry(reference, raw);
    result[reference] = {
      secret: key.secret,
      ...(key.activeFrom === undefined ? {} : { active_from: key.activeFrom }),
      ...(key.expiresAt === undefined ? {} : { expires_at: key.expiresAt }),
    };
  }
  return result;
}

async function readPrivateKeyFile(filePath: string): Promise<string> {
  if (typeof filePath !== "string" || filePath.length === 0 || /[\r\n]/u.test(filePath)) {
    throw new Error("signing_key_file_invalid");
  }
  const file = await lstat(filePath).catch(() => null);
  if (file === null || !file.isFile() || file.isSymbolicLink()
    || file.size === 0 || file.size > MAX_KEY_FILE_BYTES) {
    throw new Error("signing_key_file_unreadable");
  }
  if (process.platform !== "win32" && (file.mode & 0o077) !== 0) {
    throw new Error("signing_key_file_permissions_unsafe");
  }
  return readFile(filePath, "utf8");
}

/**
 * Resolve subscription key references without exposing key material to the
 * worker or its logs. A missing/invalid reference intentionally has one
 * stable error outcome.
 */
export class FileDeliveryKeyResolver implements DeliveryKeyResolver {
  readonly #rings: ReadonlyMap<string, KeyRing>;

  constructor(document: SigningKeyFileDocument) {
    const rings = new Map<string, KeyRing>();
    for (const [reference, value] of Object.entries(document)) {
      const key = normalizeEntry(reference, value);
      rings.set(reference, new KeyRing([key]));
    }
    this.#rings = rings;
  }

  resolve(input: { endpoint: DeliveryEndpoint; keyId: string | null }): KeyRing {
    const reference = input.keyId ?? input.endpoint.endpointRef;
    const ring = this.#rings.get(reference);
    if (ring === undefined) throw new Error("signing_key_unavailable");
    return ring;
  }
}

export async function loadFileDeliveryKeyResolver(filePath: string): Promise<FileDeliveryKeyResolver> {
  const contents = await readPrivateKeyFile(filePath);
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    throw invalidKeyFile();
  }
  return new FileDeliveryKeyResolver(parseDocument(parsed));
}
