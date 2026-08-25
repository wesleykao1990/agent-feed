import { createRequire } from "node:module";

export const runtime = "nodejs";

function diagnostic(error: unknown): Response {
  const value = error as { name?: unknown; code?: unknown; message?: unknown };
  return Response.json(
    {
      ok: false,
      stage: "hosted_bundle_evaluation",
      error_name: typeof value?.name === "string" ? value.name : "Error",
      error_code: typeof value?.code === "string" ? value.code : null,
      error_message: typeof value?.message === "string" ? value.message.slice(0, 500) : null,
    },
    { status: 503, headers: { "cache-control": "no-store" } },
  );
}

/**
 * Root Vercel handler. Resolve the rewrite marker before touching the hosted
 * runtime so /health can prove that the function itself booted. Runtime loading
 * stays behind a bounded diagnostic boundary for MCP/OAuth requests.
 */
export default {
  async fetch(request: Request): Promise<Response> {
    const incoming = new URL(request.url);
    const publicPath = incoming.searchParams.get("__agent_feed_path");
    if (publicPath === null || !publicPath.startsWith("/")) {
      return new Response("Not found", { status: 404 });
    }

    if (publicPath === "/health") {
      return Response.json(
        { ok: true, stage: "gateway_bootstrap", hosted_runtime: "not_loaded" },
        { headers: { "cache-control": "no-store" } },
      );
    }

    try {
      const runtimeGlobal = globalThis as typeof globalThis & { require?: NodeRequire };
      runtimeGlobal.require ??= createRequire(import.meta.url);
      const { hostedAgentFeedFetch } = await import("./hosted.bundle.mjs");
      incoming.searchParams.delete("__agent_feed_path");
      const publicUrl = new URL(publicPath, incoming.origin);
      for (const [name, value] of incoming.searchParams) publicUrl.searchParams.append(name, value);
      const forwarded = new Request(publicUrl, request);
      return hostedAgentFeedFetch(forwarded);
    } catch (error) {
      return diagnostic(error);
    }
  },
};
