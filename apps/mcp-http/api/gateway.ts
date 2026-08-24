export const runtime = "nodejs";

function diagnostic(error: unknown): Response {
  const code = typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code ?? "unknown")
    : "unknown";
  const name = error instanceof Error ? error.name : "Error";
  return Response.json(
    { ok: false, stage: "module_import", error_name: name, error_code: code },
    { status: 503, headers: { "cache-control": "no-store" } },
  );
}

/**
 * Vercel Web Handler for the Agent Feed MCP resource and OAuth endpoints.
 * The Agent Feed runtime is imported lazily so packaging/module-load failures
 * become controlled diagnostics instead of FUNCTION_INVOCATION_FAILED crashes.
 */
export default {
  async fetch(request: Request): Promise<Response> {
    const incoming = new URL(request.url);
    const publicPath = incoming.searchParams.get("__agent_feed_path");
    if (publicPath === null || !publicPath.startsWith("/")) {
      return new Response("Not found", { status: 404 });
    }
    incoming.searchParams.delete("__agent_feed_path");
    const publicUrl = new URL(publicPath, incoming.origin);
    for (const [name, value] of incoming.searchParams) publicUrl.searchParams.append(name, value);
    const forwarded = new Request(publicUrl, request);
    try {
      const { hostedAgentFeedFetch } = await import("../src/hosted.ts");
      return await hostedAgentFeedFetch(forwarded);
    } catch (error) {
      return diagnostic(error);
    }
  },
};
