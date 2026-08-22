import { request as httpRequest, type ClientRequest, type IncomingHttpHeaders, type IncomingMessage, type RequestOptions } from "node:http";
import { request as httpsRequest } from "node:https";
import type { HttpClient, HttpRequest, HttpResponse } from "./types.ts";

function headerRecord(headers: IncomingHttpHeaders): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    result[key] = Array.isArray(value) ? value.join(",") : value;
  }
  return result;
}

function abortError(): Error {
  const error = new Error("request_aborted");
  error.name = "AbortError";
  return error;
}

const DEFAULT_MAX_ADDRESS_ATTEMPTS = 4;

class NodeHttpClientRequestError extends Error {
  readonly beforeResponse: boolean;

  constructor(error: unknown, beforeResponse: boolean) {
    super(error instanceof Error ? error.message : "network_request_failed");
    this.name = error instanceof Error ? error.name : "Error";
    this.beforeResponse = beforeResponse;
    this.cause = error;
  }
}

export interface NodeHttpClientOptions {
  /** Maximum number of already validated addresses to try for one request. */
  maxAddressAttempts?: number;
}

/**
 * Node built-in HTTP client with fixed validated DNS addresses and body caps.
 * A connection failure before any HTTP response may fall back to another
 * already validated address. It never performs DNS resolution itself.
 */
export class NodeHttpClient implements HttpClient {
  readonly #maxAddressAttempts: number;

  constructor(options: NodeHttpClientOptions = {}) {
    this.#maxAddressAttempts = options.maxAddressAttempts ?? DEFAULT_MAX_ADDRESS_ATTEMPTS;
    if (!Number.isSafeInteger(this.#maxAddressAttempts) || this.#maxAddressAttempts < 1) {
      throw new Error("invalid_webhook_address_attempt_limit");
    }
  }

  async request(input: HttpRequest): Promise<HttpResponse> {
    const addresses = input.resolvedAddresses.slice(0, this.#maxAddressAttempts);
    if (addresses.length === 0) throw new Error("validated_address_missing");
    let lastError: unknown;
    for (const address of addresses) {
      if (input.signal.aborted) throw abortError();
      try {
        return await this.requestAddress(input, address);
      } catch (error) {
        if (input.signal.aborted) throw error;
        if (!(error instanceof NodeHttpClientRequestError) || !error.beforeResponse) throw error;
        lastError = error;
      }
    }
    throw lastError ?? new Error("network_request_failed");
  }

  private requestAddress(input: HttpRequest, address: { address: string; family: 4 | 6 }): Promise<HttpResponse> {
    const url = new URL(input.url);
    const hostname = url.hostname.replace(/^\[|\]$/gu, "");
    const commonOptions: RequestOptions = {
      protocol: url.protocol,
      hostname,
      port: url.port === "" ? (url.protocol === "https:" ? 443 : 80) : Number(url.port),
      path: `${url.pathname}${url.search}`,
      method: input.method,
      headers: input.headers,
      lookup: ((_hostname: string, options: { all?: boolean }, callback: (error: Error | null, address?: string | readonly { address: string; family: number }[], family?: number) => void) => {
        if (options.all === true) {
          callback(null, [{ address: address.address, family: address.family }]);
        } else {
          callback(null, address.address, address.family);
        }
      }) as NonNullable<RequestOptions["lookup"]>,
    };
    const requestOptions = url.protocol === "https:"
      ? { ...commonOptions, servername: hostname }
      : commonOptions;
    return new Promise<HttpResponse>((resolve, reject) => {
      let settled = false;
      let responseStarted = false;
      const finishReject = (error: unknown, beforeResponse = !responseStarted): void => {
        if (settled) return;
        settled = true;
        reject(new NodeHttpClientRequestError(error, beforeResponse));
      };
      const finishResolve = (response: HttpResponse): void => {
        if (settled) return;
        settled = true;
        resolve(response);
      };
      const handleResponse = (response: IncomingMessage): void => {
        responseStarted = true;
        const headers = headerRecord(response.headers);
        const declaredLength = Number(headers["content-length"] ?? "");
        if (Number.isFinite(declaredLength) && declaredLength > input.maxResponseBytes) {
          response.destroy();
          finishReject(new Error("response_body_too_large"));
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer | string) => {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          size += buffer.length;
          if (size > input.maxResponseBytes) {
            response.destroy();
            finishReject(new Error("response_body_too_large"));
            return;
          }
          chunks.push(buffer);
        });
        response.on("end", () => finishResolve({
          status: response.statusCode ?? 0,
          headers,
          body: Buffer.concat(chunks),
          redirected: (response.statusCode ?? 0) >= 300 && (response.statusCode ?? 0) < 400,
        }));
        response.on("error", (error) => finishReject(error, false));
      };
      const req: ClientRequest = url.protocol === "https:"
        ? httpsRequest(requestOptions, handleResponse)
        : httpRequest(commonOptions, handleResponse);
      req.on("error", (error) => finishReject(error, !responseStarted));
      if (input.signal.aborted) {
        req.destroy(abortError());
        return;
      }
      const onAbort = (): void => { req.destroy(abortError()); };
      input.signal.addEventListener("abort", onAbort, { once: true });
      req.on("close", () => { input.signal.removeEventListener("abort", onAbort); });
      req.end(input.body);
    });
  }
}
