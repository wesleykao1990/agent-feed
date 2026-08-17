import type { CursorCodec, PayloadHasher } from "./types.ts";

/**
 * Narrow shape exported by protocol-runtime. Keeping this adapter explicit
 * avoids importing crypto or reimplementing canonical JSON in this package.
 */
export interface ProtocolRuntimeHashPort {
  canonicalJson(value: unknown): string;
  sha256Hex(value: string | Uint8Array): string;
}

export function payloadHasherFromProtocolRuntime(runtime: ProtocolRuntimeHashPort): PayloadHasher {
  return {
    hash(value: unknown): string {
      return runtime.sha256Hex(runtime.canonicalJson(value));
    },
  };
}

/**
 * Adapt the delivery-core cursor implementation without adding another
 * encoding, signing, or expiry policy. DeliveryConsumerService supplies the
 * canonical `CursorPayload`, including its expiration, and core delegates
 * canonicalization/signing to the protocol-runtime ports.
 */
export function consumerCursorCodecFromRuntime(runtime: CursorCodec): CursorCodec {
  return {
    encode(claims) {
      return runtime.encode(claims);
    },
    decode(token) {
      return runtime.decode(token);
    },
  };
}
