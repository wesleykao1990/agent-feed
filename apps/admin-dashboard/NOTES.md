# Milestone 5 dashboard notes

## Decision

Use a server-rendered, dependency-free page over a narrow v1 aggregate. The
dashboard is intentionally pull-based and remains useful when Realtime is not
available. The source adapter, not the UI, owns authentication, tenancy,
aggregation, and metric allowlisting.

## Bug and threat findings

- Raw metric labels or source messages must not be inserted into HTML. The
  contract contains only fixed keys, and rendering escapes every dynamic value.
- Invalid, oversized, unavailable, and stale snapshots need separate states;
  otherwise an operator can mistake an empty dashboard for a healthy queue.
- A dashboard must not become a second delivery source of truth. This package
  reads an aggregate and exposes no mutation route.
- The local reference binds to loopback. A production deployment still needs
  authentication, authorization, TLS, and network policy outside this app.

## Learning

The most stable integration point is a versioned aggregate rather than direct
coupling to worker internals. The operations exporter can evolve its storage
and transport while this app remains a presentation adapter. Freshness is
computed from the producer timestamp, not request time, so a disconnected or

The v1 keys intentionally use durable aggregate families (`pending_events`,
`oldest_pending_age_seconds`, `active_leases`, `expired_leases`,
`dead_letters_total`, `delivery_attempts_total`, `overdue_streams`, and
`retention_eligible_artifacts`). They do not require hidden time-window
queries, which keeps the root observability adapter simple and auditable.

## Deferred work

Production authentication, an allowlisted exporter implementation, dashboard
deployment manifests, alert routing, and retention-aware historical charts are
outside this optional reference. They must be added only with corresponding
operational and security evidence.

## Milestone 5 hardening

- The HTTP server now fails closed for every non-loopback peer unless the
  deployment injects an explicit `authorize(request)` guard. The guard is
  never called for credential-shaped query strings, and denial responses are
  generic and empty so they do not disclose route or authorization details.
- `metricSnapshotToDashboardSnapshot` validates the complete canonical
  operations snapshot before selecting its eight cards. It checks exact Agent
  Feed family names, order, HELP text, sample counts, and labels; the liveness
  card requires the fixed `state="overdue"` sample. Duplicate, missing, or
  relabelled families fail closed.
- Build-time type checking and the local operations-observability package are
  explicit package dependencies so a clean install exercises the same boundary
  as the dashboard tests.
