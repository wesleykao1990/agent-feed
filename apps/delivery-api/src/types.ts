import type {
  ConsumerAuthContext,
  ConsumerAuthPort,
  DeliveryConsumerRepository,
  CursorCodec,
  PayloadHasher,
} from "@agent-feed/delivery-consumer";

/** Transport-neutral request envelope. An HTTP adapter may map its request into this shape. */
export interface DeliveryApiRequest {
  credential: unknown;
  params?: Readonly<Record<string, unknown>>;
  query?: Readonly<Record<string, unknown>>;
  body?: unknown;
}

export interface DeliveryApiResponse {
  status: number;
  body: unknown;
}

export interface CredentialResolver {
  /** Resolve only the credential; request body fields are intentionally unavailable. */
  resolve(credential: unknown): Promise<ConsumerAuthContext> | ConsumerAuthContext;
}

export interface DeliveryApiDependencies {
  repository: DeliveryConsumerRepository;
  credentials: CredentialResolver;
  cursorCodec: CursorCodec;
  payloadHasher: PayloadHasher;
  nowSeconds?: () => number;
}

export interface ResolvedAuthPort extends ConsumerAuthPort {}

export type { ConsumerAuthContext, DeliveryConsumerRepository, CursorCodec, PayloadHasher };
