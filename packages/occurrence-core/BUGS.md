# Occurrence-core known bugs

No known defects at the Milestone 7 pure-core checkpoint.

The package deliberately leaves provider-specific timezone quirks, persistent
link uniqueness, transactional misfire updates, and live PostgreSQL acceptance
to the integration/adaptor work. Those are integration obligations, not hidden
claims of this package.

## M7-OC-B001 — Closed overlap no-active edge

The initial pure overlap decision returned `suppressed` for every `skip`
request, even when no prior invocation was active. It was corrected so `allow`
is always eligible, while `skip` and `fail_closed` are eligible without an
active prior and suppress/conflict only when one is present. Exhaustive package
fixtures now cover all policy/state combinations.
