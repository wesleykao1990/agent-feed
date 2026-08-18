/**
 * Optional Supabase Edge Function ingress adapter.
 *
 * This function is intentionally a narrow HTTPS relay. The canonical Agent
 * Feed REST service remains the policy and persistence boundary: it verifies
 * the scoped producer bearer credential, validates protocol 0.1, applies
 * limits/quarantine, and performs the idempotent PostgreSQL transaction. A
 * Supabase project can host the database and expose this function without
 * introducing a second implementation of that policy.
 *
 * Required Edge Function secret:
 *   AGENT_FEED_INGRESS_URL=https://the-canonical-agent-feed-api.example
 *
 * The function forwards only the protocol routes and a small allowlist of
 * headers. It never forwards cookies, arbitrary authorization schemes, or
 * browser headers to the upstream service. Realtime is not involved.
 */

const MAX_BODY_BYTES = 1024 * 1024;
const MAX_RESPONSE_BODY_BYTES = 2 * 1024 * 1024;
const UPSTREAM = Deno.env.get("AGENT_FEED_INGRESS_URL");

function json(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function upstreamBase(): URL | null {
  if (!UPSTREAM) return null;
  try {
    const value = new URL(UPSTREAM);
    if (value.protocol !== "https:") return null;
    if (value.username || value.password || value.search || value.hash) return null;
    value.pathname = value.pathname.replace(/\/$/u, "");
    return value;
  } catch {
    return null;
  }
}

function routeAllowed(method: string, pathname: string): boolean {
  if (method === "POST" && pathname === "/v1/runs:begin") return true;
  if (method === "POST" && /^\/v1\/runs\/[^/]+\/batches$/u.test(pathname)) return true;
  if (method === "POST" && /^\/v1\/runs\/[^/]+:complete$/u.test(pathname)) return true;
  if (method === "GET" && /^\/v1\/runs\/[^/]+$/u.test(pathname)) return true;
  if (method === "GET" && /^\/v1\/runs\/[^/]+\/findings$/u.test(pathname)) return true;
  return false;
}

function routePath(pathname: string): string {
  // Supabase forwards the function name in hosted/local URLs, while direct
  // unit invocations may provide only the function-relative path.
  const hosted = /^\/functions\/v1\/[^/]+(?<route>\/.*)?$/u.exec(pathname);
  if (hosted) return hosted.groups?.route ?? "/";
  const local = /^\/producer-ingress(?<route>\/.*)?$/u.exec(pathname);
  if (local) return local.groups?.route ?? "/";
  return pathname;
}

function copyHeaders(request: Request): Headers {
  const headers = new Headers();
  const authorization = request.headers.get("authorization");
  if (!authorization || !/^Bearer[ \t]+[^ \t]+[ \t]*$/iu.test(authorization)) {
    throw new Error("bearer_required");
  }
  headers.set("authorization", authorization);
  const contentType = request.headers.get("content-type");
  if (request.method === "POST") {
    if (contentType !== "application/json") throw new Error("json_content_type_required");
    headers.set("content-type", contentType);
  }
  const requestId = request.headers.get("x-request-id");
  if (requestId && /^[A-Za-z0-9._:-]{1,128}$/u.test(requestId)) headers.set("x-request-id", requestId);
  return headers;
}

async function readBoundedResponseBody(response: Response): Promise<Uint8Array> {
  const declaredLength = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BODY_BYTES) {
    throw new Error("upstream_response_too_large");
  }
  if (!response.body) return new Uint8Array();

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BODY_BYTES) throw new Error("upstream_response_too_large");
      chunks.push(value);
    }
  } catch (error) {
    try {
      await reader.cancel();
    } catch {
      // Preserve the bounded, redacted relay error even if cancellation fails.
    }
    throw error;
  } finally {
    reader.releaseLock();
  }

  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

Deno.serve(async (request) => {
  const base = upstreamBase();
  if (!base) return json({ error: "ingress_not_configured" }, 503);

  const incoming = new URL(request.url);
  const pathname = routePath(incoming.pathname);
  if (incoming.search || !routeAllowed(request.method, pathname)) {
    return json({ error: "route_not_allowed" }, 404);
  }

  let headers: Headers;
  try {
    headers = copyHeaders(request);
  } catch (error) {
    const code = error instanceof Error ? error.message : "invalid_request";
    return json({ error: code }, code === "json_content_type_required" ? 415 : 401);
  }

  let body: Uint8Array | undefined;
  if (request.method === "POST") {
    const length = Number(request.headers.get("content-length") ?? "0");
    if (Number.isFinite(length) && length > MAX_BODY_BYTES) return json({ error: "body_too_large" }, 413);
    const bytes = new Uint8Array(await request.arrayBuffer());
    if (bytes.byteLength > MAX_BODY_BYTES) return json({ error: "body_too_large" }, 413);
    body = bytes;
  }

  const target = new URL(`${base.origin}${base.pathname}${pathname}`);
  try {
    const response = await fetch(target, {
      method: request.method,
      headers,
      ...(body === undefined ? {} : { body }),
      redirect: "error",
    });
    const responseBody = await readBoundedResponseBody(response);
    const outputHeaders = new Headers();
    const responseType = response.headers.get("content-type");
    if (responseType === "application/json") outputHeaders.set("content-type", responseType);
    outputHeaders.set("cache-control", "no-store");
    return new Response(responseBody, { status: response.status, headers: outputHeaders });
  } catch {
    // Do not return upstream URLs, request bodies, or transport diagnostics.
    return json({ error: "ingress_upstream_unavailable" }, 502);
  }
});
