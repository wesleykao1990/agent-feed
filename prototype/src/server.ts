import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { pathToFileURL } from "node:url";
import { AgentFeedStore } from "./store.ts";
import { SECURITY_DEFAULTS } from "./security.ts";
import { RunBundleImporter } from "./wire.ts";

export interface AgentFeedServerOptions {
  store?: AgentFeedStore;
  token?: string;
}

function reply(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(json),
  });
  res.end(json);
}

async function rawBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > SECURITY_DEFAULTS.maxBodyBytes) throw new Error("body_too_large");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function statusFor(error: unknown): number {
  const message = error instanceof Error ? error.message : String(error);
  if (message === "body_too_large") return 413;
  if (message.startsWith("schema_validation_failed") || message === "invalid_json") return 422;
  if (
    message.includes("idempotency_payload_conflict") ||
    message.includes("run_id_conflict") ||
    message.includes("terminal_run_immutable")
  ) {
    return 409;
  }
  if (message.includes("run_not_found")) return 404;
  return 400;
}

export function createAgentFeedServer(options: AgentFeedServerOptions = {}): Server {
  const store = options.store ?? new AgentFeedStore();
  const importer = new RunBundleImporter(store);
  const token = options.token ?? process.env.AGENT_FEED_PROTOTYPE_TOKEN ?? "prototype-only-token";

  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://agent-feed.local");
      if (req.method === "GET" && url.pathname === "/health") {
        return reply(res, 200, {
          ok: true,
          service: "agent-feed-prototype",
          protocolVersion: "0.1",
          security: SECURITY_DEFAULTS,
        });
      }
      if (req.headers.authorization !== `Bearer ${token}`) {
        return reply(res, 401, { error: "unauthorized" });
      }
      if (req.method === "GET" && url.pathname.startsWith("/runs/")) {
        const runId = decodeURIComponent(url.pathname.slice("/runs/".length));
        const run = store.getRun(runId);
        return run ? reply(res, 200, run) : reply(res, 404, { error: "run_not_found" });
      }

      const raw = await rawBody(req);
      if (req.method === "POST" && url.pathname === "/import-run-bundle") {
        const result = importer.importJson(raw);
        return reply(res, result.imported ? 201 : 200, result);
      }
      const body = raw.length > 0 ? JSON.parse(raw) : {};
      if (req.method === "POST" && url.pathname === "/begin-run") {
        return reply(res, 201, store.beginRun(body));
      }
      if (req.method === "POST" && url.pathname === "/submit-batch") {
        return reply(res, 202, store.submitBatch(body));
      }
      if (req.method === "POST" && url.pathname === "/complete-run") {
        return reply(res, 200, store.completeRun(body));
      }
      if (req.method === "POST" && url.pathname === "/expectations") {
        return reply(res, 201, store.registerExpectation(body));
      }
      if (req.method === "POST" && url.pathname === "/liveness") {
        return reply(res, 200, store.evaluateLiveness(body.now));
      }
      return reply(res, 404, { error: "not_found" });
    } catch (error) {
      return reply(res, statusFor(error), {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const server = createAgentFeedServer();
  server.listen(Number(process.env.PORT ?? 7071), "127.0.0.1", () => {
    console.log("Agent Feed prototype: http://127.0.0.1:7071");
  });
}
