# Milestone 8 learnings

## M8-L001 — Authority is not an assessment field

An assessor type or `independent=true` value submitted with a verdict cannot
prove who performed the check. Resolve one registered authority at a trusted
composition root and persist that exact immutable version.

## M8-L002 — Execution and quality need separate axes

A completed run can produce low-quality output, while a failed run remains a
technical failure even if a reviewer later explains it well. One combined
success flag loses both facts.

## M8-L003 — Unknown telemetry must survive normalization

Converting unavailable usage to zero creates false budget and efficiency
claims. State, nullable value, and provenance must be validated together in
both the pure contract and the database.

## M8-L004 — Canonical hashes require identical bytes

Semantically equivalent JSON renderers can emit different whitespace and key
ordering. Persist or reproduce the exact canonical string whose digest is
claimed; hashing a database renderer is not automatically equivalent.

## M8-L005 — Artifact proof is not artifact storage

A content hash and bounded provenance are sufficient to identify external
evidence. Inline bytes, signed download URLs, and credentials expand retention
and security scope without improving the immutable assessment receipt.

## M8-L006 — Append-only rows do not make an aggregate immutable

Preventing updates and deletes on a parent and its children still allows the
effective receipt to change when a new child is inserted later. An aggregate
receipt needs an atomic seal, a rule that blocks post-seal inserts, and reads
that exclude incomplete unsealed staging rows.

## M8-L007 — Core validation needs database-safe counterparts

Repository normalization gives callers useful errors, but direct SQL and
future adapters can bypass it. Portable numeric and credential/content
invariants need database checks as well as pure-contract checks.
