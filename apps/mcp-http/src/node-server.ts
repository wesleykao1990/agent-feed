import { once } from "node:events";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { McpHttpGateway } from "./gateway.ts";

export interface NodeGatewayServerOptions {
  gateway: McpHttpGateway;
  request_origin: URL;
  on_error?: (error: Error) => void;
}

function safeError(value: unknown): Error {
  return value instanceof Error ? new Error(value.name) : new Error("node_gateway_error");
}

async function readBody(request: IncomingMessage, maximum: number): Promise<Uint8Array | undefined> {
  if (request.method === "GET" || request.method === "HEAD") return undefined;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const value of request) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    size += chunk.byteLength;
    if (size > maximum) throw new RangeError("request_body_too_large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function writeResponse(response: Response, target: ServerResponse): Promise<void> {
  const headers: Record<string, string | string[]> = {};
  for (const [name, value] of response.headers) headers[name] = value;
  target.writeHead(response.status, headers);
  if (response.body === null) {
    target.end();
    return;
  }
  const reader = response.body.getReader();
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      if (!target.write(result.value)) await once(target, "drain");
    }
  } finally {
    reader.releaseLock();
    target.end();
  }
}

/** Node adapter with a hard streaming body cap before MCP/OAuth parsing. */
export function createNodeGatewayServer(options: NodeGatewayServerOptions): Server {
  return createServer(async (incoming, outgoing) => {
    try {
      const body = await readBody(incoming, options.gateway.max_body_bytes);
      const headers = new Headers();
      for (const [name, value] of Object.entries(incoming.headers)) {
        if (Array.isArray(value)) for (const item of value) headers.append(name, item);
        else if (value !== undefined) headers.set(name, value);
      }
      const request = new Request(new URL(incoming.url ?? "/", options.request_origin), {
        method: incoming.method ?? "GET",
        headers,
        ...(body === undefined ? {} : { body: body as BodyInit }),
      });
      await writeResponse(await options.gateway.fetch(request), outgoing);
    } catch (error) {
      options.on_error?.(safeError(error));
      if (!outgoing.headersSent) {
        const status = error instanceof RangeError ? 413 : 500;
        outgoing.writeHead(status, { "cache-control": "no-store", "content-type": "text/plain; charset=utf-8" });
      }
      outgoing.end(error instanceof RangeError ? "Request body too large" : "Internal server error");
    }
  });
}
