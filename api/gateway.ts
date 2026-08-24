export const runtime = "nodejs";

function diagnostic(stage: string, error: unknown): Response {
  const value = error as { name?: unknown; code?: unknown } | null;
  return Response.json(
    {
      ok: false,
      stage,
      error_name: typeof value?.name === "string" ? value.name : "Error",
      error_code: typeof value?.code === "string" ? value.code : null,
    },
    {
      status: 503,
      headers: { "cache-control": "no-store" },
    },
  );
}

export default {
  async fetch(request: Request): Promise<Response> {
    try {
      const module = await import("../apps/mcp-http/api/gateway.ts");
      const handler = module.default;
      if (handler === null || typeof handler !== "object" || typeof handler.fetch !== "function") {
        return diagnostic("root_handler_shape", new Error("invalid_nested_gateway_handler"));
      }
      return await handler.fetch(request);
    } catch (error) {
      return diagnostic("root_module_import", error);
    }
  },
};
