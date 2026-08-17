# Milestone 1 corrective-hardening learnings

Status: **current through the corrective implementation gate** (2026-08-18)

This is an append-only learning log. Add a dated entry when a test, review, or
implementation changes what the team knows. Keep the lesson separate from the
bug record so future milestone work can reuse it.

## M1-L001 — A passing prototype route is not durable ingress

The prototype can prove request semantics, security hooks, and route behavior
while storing all state in process memory. A durable Milestone 1 gate must test
the executable production composition root with PostgreSQL, including restart
and retry behavior. Test names such as “REST smoke” are insufficient without
the storage mode and application entrypoint.

## M1-L002 — Direct adapter tests do not prove transport composition

Calling `PostgresAgentFeedPersistence` directly proves SQL and transaction
behavior at that boundary. It does not prove that HTTP authentication, schema
validation, limits, status/error mapping, or request identity reaches the same
service. Keep direct persistence tests and add a separate live REST suite.

## M1-L003 — Source schemas and a distributable package are different artifacts

Checked-in JSON files establish source-of-truth contracts, but downstream
projects need a public package boundary with exports, version metadata, build
outputs, and an immutable artifact identity. A package name in documentation is
not evidence that the package can be installed or verified.

## M1-L004 — Protocol compatibility and package release identity are orthogonal

Wire protocol `0.1` should remain stable while package releases can carry
independent patch versions. Consumers must pin the package bytes, not infer
immutability from the wire protocol string or from a mutable repository branch.

## M1-L005 — Downstream prompts are dependency contracts

The Rewards Optimizer integration prompt is a release dependency, not merely a
task description. Its REST and artifact-pin prerequisites must be represented
in Agent Feed's acceptance matrix and checked before dispatching Milestone 2.5
builders.

## M1-L006 — Record evidence identity with every gate result

A trustworthy validation record names the source commit, command, database mode,
test counts, artifact digest, and skipped-test policy. Historical counts can be
retained, but they must be labeled historical and not silently promoted to a
new release decision.

## M1-L007 — Checksums are a final integration artifact

Regenerating repository checksums while parallel implementation branches are
still changing creates false confidence and avoidable conflicts. Generate the
checksum inventory only after API/schema code, tests, package artifact, and
documentation are integrated, then verify it in the final gate.

## M1-L008 — Wire identity must not inherit a database column type

The protocol permits opaque string run IDs, but a UUID relational key is still
useful internally. Store both explicitly and test a non-UUID ID through every
public adapter; otherwise a local-file or future SDK path can appear correct in
memory and fail only at persistence.

## M1-L009 — Exact retry means the original receipt, not current state

Idempotency is stronger than “no duplicate rows.” A begin retry after a run has
completed must return the original begin result even though the current run is
terminal. Immutable lifecycle events are a reliable receipt source.

## M1-L010 — Character limits need a stated Unicode unit

JavaScript string length counts UTF-16 code units, not Unicode code points.
Protocol-facing excerpt limits now count code points with `Array.from`, and the
boundary test uses astral characters so this cannot regress silently.

## M1-L011 — Rate-limit tests should not distort lifecycle tests

A long end-to-end lifecycle is intentionally bursty. Inject a deterministic,
high test limit for lifecycle coverage and prove the production limiter in a
focused 429/`Retry-After` test. This keeps one policy from hiding another gate.

## M1-L012 — Quarantine eligibility is transitive through evidence references

A finding that looks harmless can reference evidence marked secret, personal,
restricted, or malformed. Delivery eligibility must consider the referenced
evidence set inside the same transaction, not only finding-local flags.

## M1-L013 — A release candidate and a consumer pin are separate proofs

A deterministic tarball plus verified digest proves reproducible bytes. It is
not yet the downstream dependency contract. After merge, publish from the
immutable tag and commit the exact release URL/version/integrity to the Rewards
lockfile before beginning its integration milestone.

## M1-L014 — Gate commands must fail independently and use portable runtimes

Do not rely on a later command's exit status to represent an earlier gate.
Invoke checks independently or under fail-fast orchestration, and use
`python3` when Python 3 is the actual requirement. A missing shell alias must
not turn checksum generation into an apparent success.

## M1-L015 — Restart proof must cross the process boundary

Reconstructing a server object proves composition is repeatable, but not that
the executable entrypoint can parse deployment configuration, rerun migrations,
open a fresh pool, and shut down. Durable ingress acceptance now launches the
real entrypoint in another OS process.

## M1-L016 — Exact scopes are safer than implicit administrative wildcards

A wildcard in an ordinary producer credential silently creates a second
authorization model. Reject wildcards and introduce a separately named,
audited administrative capability if cross-producer access is ever required.

## M1-L017 — Reproducible outputs do not belong in source checksums

Source-integrity checks must produce the same file set before and after local
builds. Exclude ignored `dist`, staging, and release-artifact directories; test
the generated artifact with its own manifest and byte digests.

## M1-L018 — A populated monorepo can hide a concrete dependency

TypeScript can follow a source-linked local package into dependencies already
installed elsewhere in a developer checkout. A local green build therefore
does not prove that an application package owns only its declared boundary.
Keep the producer service dependent on an adapter-neutral port, reject concrete
PostgreSQL imports and manifest entries statically, and run its clean install
before installing the durable adapter graph used by the API composition root.

## M1-L019 — A GitHub ref name is not necessarily a release tag

Pull-request workflows expose synthetic ref names such as `3/merge`. Release
logic must use the ref type (or an explicit workflow argument), not the mere
presence of `GITHUB_REF_NAME`. Keep ordinary PR candidate builds untagged and
retain strict tag/version equality only for actual schema tag releases.
