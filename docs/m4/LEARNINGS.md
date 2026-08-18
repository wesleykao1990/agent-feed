# Milestone 4 learnings

## M4-L001 — Reference scope must be named precisely

A runnable reference can prove contract mapping and dependency boundaries. It
cannot prove a separate application's persistence, authentication, or review
workflow. Acceptance language must name which side owns each claim.

## M4-L002 — Transport duplicate does not mean “ignore all differences”

At-least-once retry permits `attempt` to change, but immutable content under an
`event_id` must remain identical. Storing a canonical source fingerprint makes
payload drift observable instead of silently collapsing it.

## M4-L003 — Transport identity is not semantic identity

`event_id` answers whether a delivery was already processed. A versioned,
consumer-owned semantic fingerprint answers whether distinct observations may
describe one proposition. Both identities and lineages are needed.

## M4-L004 — Authentication scope is not event content

Tenant and allowed streams come from caller-owned authenticated context. An
event cannot grant itself authorization by carrying a tenant-like value.

## M4-L005 — Valid producer data is still untrusted

A conforming signature or schema validates transport and shape, not factual
truth. High confidence, authority claims, excerpts, hostile instructions, and
unknown attributes remain producer claims until a consumer verifies them.

## M4-L006 — Clean-checkout order is part of the gate

Static analysis must work before ignored build artifacts exist, while
behavioral conformance must import the actual built public export. Testing both
states prevents source-only and stale-`dist` false confidence.

## M4-L007 — Tool caches can undermine reproducibility

Artifact smoke tests should not depend on user-global cache ownership. A
disposable task-local npm cache made the pack proof portable and deterministic.

## M4-L008 — Installing a source-linked package is not building its exports

An exact local `file:` dependency can be present as a symlink while its
declared `dist` entrypoint is still absent. A clean gate must build public
source-linked dependencies in dependency order; a populated checkout can hide
that requirement.
