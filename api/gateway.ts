import { createRequire } from "node:module";

export const runtime = "nodejs";

function diagnostic(error: unknown, stage = "hosted_bundle_evaluation"): Response {
  const value = error as { name?: unknown; code?: unknown; message?: unknown };
  return Response.json(
    {
      ok: false,
      stage,
      error_name: typeof value?.name === "string" ? value.name : "Error",
      error_code: typeof value?.code === "string" ? value.code : null,
      error_message: typeof value?.message === "string" ? value.message.slice(0, 500) : null,
    },
    { status: 503, headers: { "cache-control": "no-store" } },
  );
}

export default {
  async fetch(request: Request): Promise<Response> {
    const incoming = new URL(request.url);
    const publicPath = incoming.searchParams.get("__agent_feed_path");
    if (publicPath === null || !publicPath.startsWith("/")) return new Response("Not found", { status: 404 });

    const probeRuntime = publicPath === "/health" && incoming.searchParams.get("runtime") === "1";
    if (publicPath === "/health" && !probeRuntime) {
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
      incoming.searchParams.delete("runtime");
      const publicUrl = new URL(publicPath, incoming.origin);
      for (const [name, value] of incoming.searchParams) publicUrl.searchParams.append(name, value);
      const forwarded = new Request(publicUrl, request);
      const response = await hostedAgentFeedFetch(forwarded);
      if (probeRuntime && !response.ok) {
        const body = await response.text();
        return Response.json(
          { ok: false, stage: "hosted_runtime_probe", status: response.status, detail: body.slice(0, 500) },
          { status: 503, headers: { "cache-control": "no-store" } },
        );
      }
      return response;
    } catch (error) {
      return diagnostic(error, probeRuntime ? "hosted_runtime_probe" : "hosted_bundle_evaluation");
    }
  },
};
