import { hostedAgentFeedFetch } from "../src/hosted.ts";

export const runtime = "nodejs";

/**
 * Vercel Web Handler for the Agent Feed MCP resource and OAuth endpoints.
 * Rewrites pass the original public path through `__agent_feed_path` so the
 * transport-independent gateway sees the canonical /mcp, /.well-known/*,
 * /oauth/* or /health route instead of the internal /api/gateway path.
 */
export default async function handler(request: Request): Promise<Response> {
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
}
