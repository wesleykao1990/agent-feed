import { hostedAgentFeedFetch } from "../apps/mcp-http/src/hosted.ts";

export const runtime = "nodejs";

/**
 * Root Vercel Web Standard handler. Keep the hosted runtime in the static
 * dependency graph so Vercel traces workspace packages and their node_modules
 * dependencies into the serverless function bundle.
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
    return hostedAgentFeedFetch(forwarded);
  },
};
