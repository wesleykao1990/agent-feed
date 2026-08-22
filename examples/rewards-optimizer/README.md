# Generic Agent Feed reference consumer

This directory is a runnable TypeScript reference consumer for the Agent Feed
protocol. Despite the historical directory name, it is not a Rewards
Optimizer application: it has no reward rules, recommendation engine,
automatic action, database, or server internals.

The example uses the checked-in synthetic `delivery-event.example.json` and the
published protocol types re-exported by `@agent-feed/sdk`.

## Run it

From this directory:

```sh
npm install
npm run verify
```

The dependency on `@agent-feed/sdk` is an exact local file pin
(`file:../../packages/sdk/typescript`) so the example always uses the SDK in
this checkout. The TypeScript and Node type dependencies are exact versions as
well. Build the SDK first when starting from a clean checkout; its package
`prepack` hook also builds it during a normal install.

`npm run build` removes and recreates `dist/`, emits ESM JavaScript and
declarations, and excludes tests from the artifact. `npm test` type-checks the
source and tests, then runs the tests through Node's built-in test runner.

## Boundary and trust decisions

The consumer boundary is intentionally small:

```text
DeliveryEvent/finding.submitted
  -> Finding producer claim
  -> UntrustedSourceObservation
  -> caller-owned verification and domain policy
```

`mapDeliveryEvent` preserves the Finding and submitted evidence inside an
observation marked `trust: "untrusted"` and
`promotion_status: "not_promoted"`. It requires an authenticated
`tenant_id` scope supplied by the caller; tenant scope is never read from the
delivery body. It does not fetch a URL, execute or obey source text, infer
canonical truth, or promote submitted evidence. Evidence and instruction-like
text remain data for a later verification step.

Two dedupe layers are deliberately separate:

- Transport replay dedupe uses a tenant/consumer-scoped `DeliveryEvent.event_id`. A
  replay with a new `attempt` is reported as `transport_duplicate`.
- Semantic dedupe uses the consumer-owned `defaultSemanticFingerprint`, based
  on finding type, title, summary, subject identity, effective time, and open
  attributes. The resulting key is scoped by `tenant_id`, `consumer_id`, and
  `stream_id`; it excludes `event_id`, `attempt`, and the producer's
  `producer_dedupe_key`. A different transport event carrying the same
  semantic claim is reported as `semantic_duplicate` while its untrusted
  observation is still retained.

The example exposes no promotion method. `ReferenceConsumer` only records
transport keys, semantic keys, and untrusted observations. A real consumer
must add source verification and explicit human/application policy before any
domain-specific use.

`reward-claim.example.json` is a synthetic transport fragment for a Rewards
consumer. Its `attributes.reward_claims` value is consumer-owned structured
data, not an Agent Feed-validated rule: unknown fields are preserved, and
`missing_fields` plus `claim_completeness: "partial"` make incompleteness
explicit. The requirement-only credential descriptor carries eligibility
semantics without carrying a credential value. No URL or real economic value
is included.

## Reuse in another consumer

Import the built package from `dist` or use the source during local
development:

```ts
import { ReferenceConsumer } from "@agent-feed/rewards-optimizer-reference";

const consumer = new ReferenceConsumer({
  tenant_id: "tenant.example",
  consumer_id: "consumer.example",
  allowed_stream_ids: ["source-monitor.example"],
});
const result = consumer.ingest(deliveryEvent);

if (result.observation?.trust === "untrusted") {
  // Queue verification; do not treat the Finding as canonical truth.
}
```

Pass `semantic_fingerprint` to supply an application-owned semantic identity;
the callback receives a Finding and never receives transport identifiers.
