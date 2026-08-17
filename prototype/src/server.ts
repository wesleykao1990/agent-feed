import { createServer } from "node:http";
import { AgentFeedStore } from "./store.ts";
import { SECURITY_DEFAULTS } from "./security.ts";

const store = new AgentFeedStore();
const token = process.env.AGENT_FEED_PROTOTYPE_TOKEN ?? "prototype-only-token";
function reply(res: any, status: number, body: unknown) {
  const json = JSON.stringify(body, null, 2);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(json) });
  res.end(json);
}
const server = createServer(async (req, res) => {
  try {
    if (req.method === "GET" && req.url === "/health") return reply(res, 200, { ok: true, service: "agent-feed-prototype", security: SECURITY_DEFAULTS });
    if (req.headers.authorization !== `Bearer ${token}`) return reply(res, 401, { error: "unauthorized" });
    const chunks: Buffer[] = []; let size = 0;
    for await (const chunk of req) { const buffer = Buffer.from(chunk); size += buffer.length; if (size > SECURITY_DEFAULTS.maxBodyBytes) throw new Error("body_too_large"); chunks.push(buffer); }
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
    if (req.method === "POST" && req.url === "/begin-run") return reply(res, 201, store.beginRun(body));
    if (req.method === "POST" && req.url === "/submit-batch") return reply(res, 202, store.submitBatch(body));
    if (req.method === "POST" && req.url === "/complete-run") return reply(res, 200, store.completeRun(body));
    if (req.method === "POST" && req.url === "/expectations") return reply(res, 201, store.registerExpectation(body));
    if (req.method === "POST" && req.url === "/liveness") return reply(res, 200, store.evaluateLiveness(body.now));
    return reply(res, 404, { error: "not_found" });
  } catch (error) { return reply(res, 400, { error: error instanceof Error ? error.message : String(error) }); }
});
server.listen(Number(process.env.PORT ?? 7071), "127.0.0.1", () => console.log("Agent Feed prototype: http://127.0.0.1:7071"));
