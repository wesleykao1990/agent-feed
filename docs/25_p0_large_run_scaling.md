# P0 large-run scaling checkpoint

Status: **TypeScript SDK pure checkpoint green locally; production scale is not
yet claimed**

## Evidence reviewed

The prior rehearsal proved one exact synthetic target path:

1. validate a local protocol `0.1` run bundle;
2. map one finding into an explicitly untrusted observation;
3. retain submitted evidence as lead-only;
4. record one bounded target attempt; and
5. preserve a later correction without publishing domain truth.

It did not prove broad target coverage. A larger cohort still requires explicit
producer inputs, truthful locator/marker validation, deterministic extraction,
authenticity checks, and correction handling. Those remain producer and
downstream-consumer responsibilities; Agent Feed records attempts and
transports untrusted findings/evidence without deciding downstream support or
publishing domain truth.

## Transport gap found

Protocol `0.1` already supports repeated `submit_batch` calls, durable
idempotency, exact retries, and explicit partial/terminal completion. The
TypeScript producer SDK exposed only a single-batch call, leaving every large
producer to invent its own chunking, body accounting, evidence ordering,
restart identity, and backpressure loop.

That gap is material even when 44 small findings happen to fit in one request:
real evidence excerpts can hit the 1 MiB body limit before the item limit, and
future cohorts can exceed both. Raising limits would increase memory and abuse
risk rather than solve resumability.

## Implemented boundary

`@agent-feed/sdk` now provides:

- `planLargeRunBatches`, an async generator over synchronous or asynchronous
  `LargeRunUnit` sources;
- existing 1 MiB, 100-finding, and 100-evidence deployment defaults;
- exact UTF-8 serialized body measurement;
- atomic units that are never split across batches;
- evidence-reference validation against the same or an earlier unit;
- global duplicate finding/evidence ID rejection;
- canonical content-derived batch IDs and idempotency keys; and
- `ProducerClient.submitLargeRun`, which awaits each durable batch receipt
  before requesting the next and exposes an accepted-batch checkpoint hook.

The persistence package also now has an additive `0008_target_attempt_ledger`
sidecar. It records deployment-UUID/run/work-unit/target attempts with
deterministic idempotency, monotone attempt numbers, bounded credential-free
locator material, and generic outcomes. A tenant-scoped immutable run-to-
deployment binding proves that all attempts in a run use one registered job
deployment. Derived latest and last-resolved projections preserve a prior
resolution when a later retry fails. This ledger does not change protocol
`0.1`, job scheduling, or downstream-domain semantics.

## Generic source recovery

The ChatGPT/Codex producer guidance now defines a deterministic per-target
retrieval ladder: registered locator; normal browser headers and bounded
redirects; bounded `429`/`5xx` backoff; finite producer-approved alternate
official host/path candidates; validated static/PDF/language/CDN equivalents;
one browser-rendered fallback for a JavaScript-empty response; then the
explicit unresolved terminal `operator_capture_required`. It forbids login,
credentials/cookies, CAPTCHA, WAF bypass, search snippets as evidence, and
invented claims. Each attempt has one of the generic recovery results
`http_failure`, `js_empty`, `marker_missing`, `partial_role`,
`safety_rejected`, or `resolved`; a resolved candidate must pass the configured
publisher, domain, title, and marker checks.

This is producer recovery guidance, not a new Agent Feed protocol or crawler.
Alternate locators remain leads until fetched and validated. LR-D006 remains
in force: Agent Feed records attempts/findings/evidence but does not decide
downstream product support, source authority, or canonical truth. The additive `0009_target_attempt_recovery_detail`
migration preserves the existing coarse target-attempt `outcome` and adds a
nullable exact `recovery_detail`, with closed coarse/detail coherence checks,
payload-hash/idempotency coverage, and latest/last-resolved projection output.
Legacy callers remain valid with `recovery_detail: null`; the field is a
provider-neutral ledger diagnostic, not a canonical finding/evidence or
downstream-domain decision. The producer must not smuggle unsupported detail through a
locator, digest, count, or claim field.

Input order, fixed `submitted_at`, metadata, limits, and content are part of
plan identity. Replaying those exact inputs produces byte-equal requests.
Changing any of them is a new plan, not a resume.

## Deliberate non-goals

- no protocol `0.1` schema change;
- no larger ingress or database limits;
- no automatic run completion;
- no provider/domain support vocabulary in Agent Feed;
- no automatic crawler, scheduler, or canonical-evidence promotion;
- no claim that 250 synthetic units establish sustained production throughput;
  and
- no parent/child sharding model until a real workload proves one run with
  repeated bounded batches is insufficient.

## Next proof

The synthetic live PostgreSQL gate proves 250 findings and evidence records
across three batches plus exact terminal retry. It is durability evidence, not
a throughput benchmark. Use an authorized target cohort when available to run a
live rehearsal through durable REST. Record total bytes, batches, rate-limit
delay, transient retries, database latency, delivery backlog, downstream review
yield, and interruption recovery. Production scale requires a shared limiter or
gateway for multiple API replicas; the built-in limiter is process-local by
design.

## Bounded historical delivery proof

The Rewards P0 recovery set later required delivery of events that predated
its consumer subscription. Agent Feed now exposes one operator-only
materializer that accepts exact event IDs plus an exact run-ID cross-check. It
reapplies the active subscription selectors in one transaction and has no
date, position, stream, run, or all-history wildcard. Missing, repeated,
cross-tenant, cross-run, quarantined, or selector-mismatched members roll back
the entire set. Repeating the same exact set is idempotent.

The authorized live proof materialized 21 events from five exact runs and no
others. A temporary HTTPS hostname expired before the first send, producing 21
normal retry transitions without consumer side effects. Endpoint rotation
then acknowledged 17 events; four subset terminal events initially returned
HTTP 500 because the Rewards consumer redacted their raw payload before its
target-scope reconciliation. After the consumer retained only an immutable
target-ID scope projection, those four retries acknowledged. Final Agent Feed
state was 21 acknowledged deliveries, zero retry/dead-letter rows, and 46
attempt records (21 succeeded and 25 failed before retry).

Two transport lessons are now encoded in code. First, a DNS name may resolve
to several already-policy-approved addresses; the webhook client tries a
bounded maximum of four pinned addresses only for connection failures before
response headers. It never re-resolves DNS, follows a redirect, retries after
an HTTP response, or weakens private-address rejection. Second, historical
delivery is a narrowly authorized queue operation, not a reason to make all
old outbox history visible to every new subscription.
