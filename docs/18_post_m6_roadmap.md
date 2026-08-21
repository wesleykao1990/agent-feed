# Agent Feed roadmap after Milestone 6

Approved: 2026-08-20

## Direction

Agent Feed evolves into the scheduler-neutral proof and control plane for
recurring and event-driven agent work. It records five independent proof
layers without collapsing them into one success flag:

1. occurrence — whether an expected invocation arrived;
2. execution — what the producer completed, partially completed, or failed;
3. job proof — what independent checks concluded;
4. delivery — whether each consumer received the durable event; and
5. utility — whether a consumer accepted or acted on the result.

Agent Feed remains an ingestion, evidence, delivery, and audit system. It does
not become a scheduler, workflow builder, general artifact store, or automatic
prompt optimizer.

## Compatibility strategy

Protocol `0.1` remains immutable. New capabilities begin as versioned,
append-only sidecar schemas, tables, events, SDK surfaces, and read models.
Only fields proven universal across multiple schedulers, executors, ingress
paths, and consumers are candidates for a later protocol `0.2`.

## Milestone 7 — Occurrence ledger and liveness correctness

Deliver versioned schedule expectations, expected occurrences,
run-to-occurrence links, trigger kinds, explicit/windowed/legacy matching,
interval and cron/timezone schedules, and deterministic misfire/overlap
policies. Manual, test, replay, retry, and backfill executions must not move a
scheduled occurrence. A delayed execution must not drift a fixed schedule.

Gate: a scheduled zero-finding run satisfies exactly one occurrence; invocation
failure differs from absence; duplicate matching fails closed; legacy stream
expectations migrate without changing protocol `0.1`; timezone, overlap, and
misfire fixtures pass against live PostgreSQL.

## Milestone 8 — Independent job proof and operational receipts

Deliver append-only validation policies and run assessments with assessor
identity/type, typed failure stage/class, stop reasons, declared budgets,
observed usage with provenance, and hashed artifact references.

Gate: producer self-checks cannot impersonate independent assessment;
reassessment never mutates a run; technical completion remains separate from
quality; unknown telemetry stays explicitly unknown; Agent Feed stores
artifact identity and provenance rather than blobs.

## Milestone 9 — Portable job registry and capability profiles

Deliver immutable job-definition versions, owner/lifecycle state, instruction
digests or controlled references, policy references, required capabilities,
output contracts, scheduler/executor/ingress topology, deployment bindings,
off-switch references, and provider capability preflight.

Gate: one logical job retains history when moved between providers; definitions
contain no secrets; incompatible deployments fail before activation; autonomous
activation requires an owner, off-switch, budget, validation policy, and
successful shadow evidence.

## Milestone 10 — Production control plane

Deliver a tenant-scoped job/occurrence/run/assessment/delivery read model,
read-only operator dashboard, stable HTTPS deployment, durable external
OAuth/OIDC, revocation/rotation, production metrics, alerts, and recovery
runbooks. Hosted database and Supabase receipts remain explicit deployment
evidence rather than implications of local compatibility.

Gate: provider, gateway, execution, validation, and delivery failures are
distinguishable; sensitive payloads never enter aggregates; multi-instance
identity and revocation survive restarts; production non-claims from Milestone
6 are either resolved or remain explicitly out of scope.

## Milestone 11 — Multi-provider conformance

Exercise ChatGPT Scheduled Tasks, Claude custom connectors, generic remote MCP,
durable REST, one workflow scheduler, and one local/offline runner. Add Gemini,
Genspark, Grok, or other providers only when a documented MCP, webhook, API, or
export boundary exists.

Gate: one logical job produces comparable occurrence, execution, assessment,
and delivery proof through at least three provider topologies; unsupported
telemetry remains nullable; provider-specific behavior stays in adapters and
execution-context sidecars.

## Milestone 12 — Utility and optimization feedback

Deliver append-only finding and artifact dispositions such as surfaced,
ignored, duplicate, invalid, saved, acted-on, promoted, and rejected. Add
bounded metrics for review burden, source yield, time to action, and cost per
accepted or acted-on result.

Gate: feedback remains consumer-owned and cannot rewrite findings; comparisons
are scoped to definition and policy versions; prompt or schedule changes are
recommendations and require approval.

## Pre-Milestone 13 scaling checkpoint — bounded large-run submission

The Rewards Optimizer P0 rehearsal proved one family-role result through a
three-event Agent Feed bundle, then identified 44-family producer coverage as
the next data step. Before treating that expansion as evidence for protocol
`0.2`, provide deterministic bounded producer batching, sequential backpressure,
and restart-safe exact retries without increasing protocol or ingress limits.

Gate: an asynchronous stream larger than one protocol batch stays within the
1 MiB and deployment item limits; a finding remains atomic with newly
introduced evidence; duplicate IDs, forward evidence references, and a single
oversized unit fail closed; regenerating an identical stopped plan produces
byte-equal requests; completion remains explicit. See
`docs/25_p0_large_run_scaling.md` and `docs/large-run/`.

## Milestone 13 — Protocol 0.2 decision

Evaluate sidecars only after use through at least three provider topologies,
two consumers, multiple schedule modes, replay/backfill fixtures, more than one
assessor type, and real utility feedback. Promote only universal fields, with a
published compatibility policy, immutable schema artifact, migration fixtures,
and complete protocol `0.1` regression.

## Gate discipline

Every milestone must include focused package checks, architecture/adversarial
guards, live PostgreSQL acceptance where durability is claimed, complete prior
milestone regression, clean-install/package proof, hosted CI, and append-only
decision, bug, learning, acceptance, and refactor-debt records.
