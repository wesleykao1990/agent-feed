export const runtime = "nodejs";

function diagnostic(error: unknown): Response {
  const value = error as { name?: unknown; code?: unknown } | null;
  return Response.json(
    {
      ok: false,
      stage: "hosted_bundle_import",
      error_name: typeof value?.name === "string" ? value.name : "Error",
      error_code: typeof value?.code === "string" ? value.code : null,
    },
    { status: 503, headers: { "cache-control": "no-store" } },
  );
}

/**
 * Root Vercel Web Standard handler. The hosted Agent Feed runtime is bundled
 * into api/hosted.bundle.mjs during Vercel installation so the deployed
 * function has no runtime dependency on pnpm workspace package resolution.
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
      const runtime = await import("./hosted.bundle.mjs");
      if (typeof runtime.hostedAgentFeedFetch !== "function") {
        throw new Error("hosted_bundle_missing_fetch");
      }
      return await runtime.hostedAgentFeedFetch(forwarded);
    } catch (error) {
      return diagnostic(error);
    }
  },
};
