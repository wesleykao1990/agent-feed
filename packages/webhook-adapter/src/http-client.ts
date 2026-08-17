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

/** Node built-in HTTP client with fixed validated DNS addresses and body caps. */
export class NodeHttpClient implements HttpClient {
  request(input: HttpRequest): Promise<HttpResponse> {
    const url = new URL(input.url);
    const address = input.resolvedAddresses[0];
    if (!address) return Promise.reject(new Error("validated_address_missing"));
    const hostname = url.hostname.replace(/^\[|\]$/gu, "");
    const commonOptions: RequestOptions = {
      protocol: url.protocol,
      hostname,
      port: url.port === "" ? (url.protocol === "https:" ? 443 : 80) : Number(url.port),
      path: `${url.pathname}${url.search}`,
      method: input.method,
      headers: input.headers,
      lookup: ((_hostname: string, _options: unknown, callback: (error: Error | null, address?: string, family?: number) => void) => {
        callback(null, address.address, address.family);
      }) as NonNullable<RequestOptions["lookup"]>,
    };
    const requestOptions = url.protocol === "https:"
      ? { ...commonOptions, servername: hostname }
      : commonOptions;
    return new Promise<HttpResponse>((resolve, reject) => {
      let settled = false;
      const finishReject = (error: unknown): void => {
        if (settled) return;
        settled = true;
        reject(error);
      };
      const finishResolve = (response: HttpResponse): void => {
        if (settled) return;
        settled = true;
        resolve(response);
      };
      const handleResponse = (response: IncomingMessage): void => {
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
        response.on("error", finishReject);
      };
      const req: ClientRequest = url.protocol === "https:"
        ? httpsRequest(requestOptions, handleResponse)
        : httpRequest(commonOptions, handleResponse);
      req.on("error", finishReject);
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
