# Codex prompt — maintain Agent Feed Milestone 4

Maintain and extend only the generic reference consumer in
`examples/rewards-optimizer/`. Despite the historical directory name, this is
an Agent Feed protocol example, not authorization to change or implement the
separate Rewards Optimizer repository.

## Read first

- `docs/01_protocol.md`
- `docs/02_trust_model.md`
- `docs/06_rewards_optimizer_consumer.md`
- `docs/14_milestone_4_reference_consumer.md`
- `docs/m4/DECISIONS.md`
- `examples/rewards-optimizer/README.md`

## Required invariants

1. Use only public Agent Feed package exports; never import persistence, API,
   MCP, worker, database, Realtime, or another package's `/src` path.
2. Accept authenticated `tenant_id`, `consumer_id`, and a non-empty stream
   allowlist from caller context. Never derive authorization from event data.
3. Validate protocol `0.1`; map only `finding.submitted` to an explicitly
   untrusted, non-promoted observation. Lifecycle events create no observation.
4. Keep scoped `event_id` receipt identity separate from a versioned semantic
   key. Changed retry `attempt` is valid; changed immutable content under the
   same event ID must fail closed with a redacted error.
5. Clone and retain finding claims, submitted evidence, security flags,
   handling restrictions, and unknown attributes as data. Never execute source
   text, fetch source URLs, infer truth, or expose promotion/rule outputs.
6. Keep the example storage-free and server-free. Its in-memory state is a
   replaceable demonstration, not production durability.

## Verification

Run:

```sh
npm --prefix packages/sdk/typescript ci
npm --prefix examples/rewards-optimizer ci
npm run m4:conformance
```

The gate must build and import the public artifact, run focused and public
behavioral tests, scan the dependency boundary, perform a pack smoke check,
and fail if any acceptance test is skipped.

Record every decision, bug, learning, and accepted limitation in `docs/m4/`.
Do not mark production signed ingress, durable receipt-before-ACK, retry/DLQ,
canonical evidence, or Rewards-domain review as complete here; those belong to
their owning application/deployment.
