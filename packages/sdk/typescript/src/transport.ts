import {
  AgentFeedAbortError,
  AgentFeedError,
  AgentFeedTimeoutError,
  AgentFeedTransportError,
  type AgentFeedErrorOptions,
} from "./errors.ts";

export type AgentFeedHttpMethod = "GET" | "POST" | "PATCH";

export interface AgentFeedTransportRequest {
  readonly method: AgentFeedHttpMethod;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string;
  readonly signal: AbortSignal;
}

export interface AgentFeedTransportResponse {
  readonly status: number;
  /** Implementations may return an already-decoded JSON value. */
  readonly body?: unknown;
  readonly headers?: Readonly<Record<string, string>>;
}

/** Injectable HTTP/transport port used by both SDK clients. */
export interface AgentFeedTransport {
  request(input: AgentFeedTransportRequest): Promise<AgentFeedTransportResponse>;
}

export interface FetchTransportOptions {
  /** Useful for tests and runtimes that provide a fetch-compatible function. */
  readonly fetch?: typeof globalThis.fetch;
}

function headersToRecord(headers: Headers): Record<string, string> {
  const result: Record<string, string> = {};
  headers.forEach((value, key) => { result[key.toLowerCase()] = value; });
  return result;
}

function decodeBody(text: string, contentType: string | null): unknown {
  if (text.length === 0) return undefined;
  if (contentType?.toLowerCase().includes("json") !== true) return text;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    // Keep malformed JSON opaque; the client will turn it into a redacted
    // AgentFeedResponseError rather than exposing response bytes.
    return text;
  }
}

/** Fetch-backed transport; redirects and connection policy remain runtime-owned. */
export class FetchTransport implements AgentFeedTransport {
  readonly #fetch: typeof globalThis.fetch;

  constructor(options: FetchTransportOptions = {}) {
    const fetchImplementation = options.fetch ?? globalThis.fetch;
    if (typeof fetchImplementation !== "function") throw new Error("fetch_implementation_required");
    this.#fetch = fetchImplementation;
  }

  async request(input: AgentFeedTransportRequest): Promise<AgentFeedTransportResponse> {
    let response: Response;
    try {
      response = await this.#fetch(input.url, {
        method: input.method,
        headers: input.headers,
        ...(input.body === undefined ? {} : { body: input.body }),
        signal: input.signal,
        redirect: "error",
      });
    } catch (error) {
      if (input.signal.aborted) {
        const reason = input.signal.reason;
        if (reason === "agent-feed-timeout") {
          throw new AgentFeedTimeoutError({ operation: "transport", retryable: true });
        }
        throw new AgentFeedAbortError({ operation: "transport" });
      }
      if (error instanceof AgentFeedError) throw error;
      throw new AgentFeedTransportError({ operation: "transport", retryable: true });
    }
    const text = await response.text();
    return {
      status: response.status,
      headers: headersToRecord(response.headers),
      body: decodeBody(text, response.headers.get("content-type")),
    };
  }
}

/** Compatibility alias for callers that prefer the transport's role name. */
export { FetchTransport as HttpTransport };

export function isAbortLike(value: unknown): boolean {
  return value instanceof AgentFeedAbortError || (value instanceof Error && value.name === "AbortError");
}

export function isTimeoutLike(value: unknown): boolean {
  return value instanceof AgentFeedTimeoutError || (value instanceof Error && value.name === "TimeoutError");
}

export function transportErrorOptions(operation: string): AgentFeedErrorOptions {
  return { operation, retryable: true };
}
