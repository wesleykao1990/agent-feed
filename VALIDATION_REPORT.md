# Agent Feed Foundation v0.1.1 validation report

Validated: **2026-08-18**

## Result

**Milestone 1 corrective implementation gate passed locally; immutable schema
publication and the Rewards Optimizer dependency pin remain release actions.**

The executable producer surface is now `apps/api`, composed through
`@agent-feed/producer-service` and backed by
`PostgresAgentFeedPersistence`. It accepts canonical protocol `0.1` requests,
does not import the prototype, contains no handler SQL, and preserves data and
idempotency receipts across an API restart. The local-file adapter uses the
same application service and durable store.

Current green evidence:

- protocol generated-type drift and compatibility checks;
- foundation package validator;
- Milestone 0/1 conformance: **23/23**;
- in-memory prototype regression: **29/29** (supporting evidence only);
- publishable schema package: **4/4**;
- producer application service: **9/9**;
- producer API: **2/2**;
- durable local-file adapter: **6/6**;
- live PostgreSQL producer ingress: **5/5**, including API restart;
- direct PostgreSQL persistence: **11/11**;
- full M2 conformance: architecture 4, pure 6, live PostgreSQL 3,
  protocol-runtime 5, delivery-core 18, delivery-consumer 10, persistence 11,
  webhook 8, worker 6, and delivery API 5;
- final repository source-integrity inventory: **236/236**, from a
  clean-equivalent checkout (ignored build/release outputs are excluded).

The live producer gate rejects a missing database URL rather than converting it
to a skip. It covers tenant/producer/stream authorization, exact retries and
payload drift, atomic evidence/outbox writes, terminal immutability,
completed-zero queryability, size/cardinality/Unicode/metadata boundaries,
secret and hostile evidence handling, quarantine eligibility, and rate-limit
responses.

An independent adversarial re-audit cleared the checksum, real process-restart,
exact producer scope, migration-ledger, media-type/draining, and static-boundary
issues. The first hosted PR run then found a source-linked concrete adapter
dependency that a populated local checkout had masked. The producer service now
owns an adapter-neutral persistence port and its architecture gate rejects that
dependency class. The only remaining release dependency is the intentional
post-merge schema publication and downstream Rewards pin.

## Schema release candidate

`@agent-feed/schema@0.1.1` is independently buildable and publishable while its
wire protocol remains `0.1`. The deterministic local candidate is:

- artifact: `agent-feed-schema-0.1.1.tgz`;
- SHA-256: `b6c8c6beb98fea305346f4a23f049deba8498beba84fa643d49c9ecfb8adce75`;
- SHA-512 integrity: `sha512-Gy3pWM0xNwuGxwXTHx9PH1HmqUwevtToAuXPJQ1JLCScn8+PPJ6atJkO+/2txRAWSRPJ63LlTw3sqSvHLeAxHQ==`.

The `schema-v*` workflow validates tag/package-version equality, rebuilds and
verifies the artifact from tagged source, and uploads without replacement.
The immutable release URL/source commit and Rewards Optimizer lockfile pin
cannot truthfully be recorded before this PR is reviewed, merged, tagged, and
released. Those are the only remaining M1 release-gate actions; they do not
invalidate the green implementation evidence above. See
`docs/m1-hardening/ACCEPTANCE.md`.
