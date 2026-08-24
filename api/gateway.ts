import { hostedAgentFeedFetch } from "./hosted.bundle.mjs";

export const runtime = "nodejs";

/**
 * Root Vercel Web Standard handler. The hosted Agent Feed runtime is bundled
 * during Vercel's build step and statically imported here so Vercel traces the
 * generated artifact into the serverless function package.
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
