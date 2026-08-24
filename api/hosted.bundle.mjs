export async function hostedAgentFeedFetch() {
  return Response.json(
    { ok: false, stage: "bundle_placeholder_loaded" },
    { status: 503, headers: { "cache-control": "no-store" } },
  );
}
