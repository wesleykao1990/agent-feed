import { createRequire } from "node:module";

export const runtime = "nodejs";

/**
 * The checked-in esbuild ESM bundle contains CommonJS dependencies (notably
 * node-postgres) whose generated interop helper expects Node's `require` to be
 * available at runtime. Vercel evaluates this function as ESM, where `require`
 * is otherwise absent. Expose a Node createRequire bridge before evaluating the
 * hosted bundle, while keeping the import behind the diagnostic boundary.
 */
export default {
  async fetch(request: Request): Promise<Response> {
    try {
      const runtimeGlobal = globalThis as typeof globalThis & { require?: NodeRequire };
      runtimeGlobal.require ??= createRequire(import.meta.url);
      const { hostedAgentFeedFetch } = await import("./hosted.bundle.mjs");
      const incoming = new URL(request.url);
      const publicPath = incoming.searchParams.get("__agent_feed_path");
      if (publicPath === null || !publicPath.startsWith("/")) {
        return new Response("Not found", { status: 404 });
      }
      incoming.searchParams.delete("__agent_feed_path");
      const publicUrl = new URL(publicPath, incoming.origin);
      for (const [name, value] of incoming.searchParams) publicUrl.searchParams.append(name, value);
      const forwarded = new Request(publicUrl, request);
      return hostedAgentFeedFetch(forwarded);
    } catch (error) {
      const value = error as { name?: unknown; code?: unknown; message?: unknown };
      return Response.json(
        {
          ok: false,
          stage: "hosted_bundle_evaluation",
          error_name: typeof value?.name === "string" ? value.name : "Error",
          error_code: typeof value?.code === "string" ? value.code : null,
          error_message: typeof value?.message === "string" ? value.message.slice(0, 500) : null,
        },
        { status: 503 },
      );
    }
  },
};
