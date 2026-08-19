# `@agent-feed/operations-observability`

This package is the Milestone 5 operational metrics boundary for Agent Feed.
It turns one already-aggregated persistence snapshot into a deterministic,
bounded metric snapshot and renders that snapshot as Prometheus text.

## Scope

The package covers:

- pending delivery backlog, oldest pending age, active leases, and expired leases;
- cumulative attempts, failures, retries, acknowledgements, and dead letters;
- stream liveness grouped into the durable states `healthy`, `due`, `overdue`,
  `degraded`, `disabled`, or `never_seen`;
- row/byte storage and retention-candidate indicators; and
- estimated egress bytes and delivery cost in USD.

The package is intentionally transport- and database-neutral. It does not
open a database connection, inspect event bodies, or choose a tenant,
consumer, subscription, producer, URL, finding, routing tag, or raw error as a
metric label. Only the fixed enum dimensions in `src/types.ts` are exported.
Unknown runtime keys are ignored.

`toPrometheus` validates the complete snapshot again at runtime. A forged
TypeScript object, deserialized cache entry, or cross-process message is
rejected unless its protocol version, canonical timestamp, family order,
names, types, HELP strings, sample counts, fixed labels, and finite
non-negative values exactly match the collector contract. Control characters
are rejected before any exposition text is assembled.

## Example

```ts
import { collectMetrics, toPrometheus } from "@agent-feed/operations-observability";

const snapshot = collectMetrics({
  observedAt: new Date().toISOString(),
  backlog: {
    pendingEvents: 12,
    oldestPendingAgeSeconds: 90,
    activeLeases: 2,
    expiredLeases: 1,
  },
  attempts: {
    total: 100,
    byOutcome: { delivered: 80, retry: 10, failed: 8, dead_letter: 2 },
    failuresByReason: { timeout: 4, transport: 2, server: 2 },
  },
  liveness: {
    expectedStreams: 6,
    byState: { healthy: 2, due: 1, overdue: 1, degraded: 1, disabled: 1, never_seen: 0 },
  },
  storage: {
    outboxRows: 100,
    deliveryRows: 120,
    attemptRows: 220,
    totalBytes: 4096,
    managedArtifactRows: 7,
    managedArtifactBytes: 512,
  },
  cost: { egressBytesTotal: 8192, estimatedCostUsdTotal: 0.42 },
});

const prometheusBody = toPrometheus(snapshot);
```

`collectMetrics` caps count, age, byte, and cost values at configurable
limits. It rejects negative, non-finite, or fractional count values. The
default caps are deliberately below JavaScript's unsafe-integer boundary.

## Persistence adapter requirements

The composition root should implement a read-only `MetricsSampleProvider`
equivalent to the input shape and pass one transactionally consistent sample
to `collectMetrics`. The adapter should:

1. aggregate by tenant/consumer/subscription inside SQL, then discard those
   dimensions before calling this package;
2. calculate pending/lease/attempt counts from the authoritative delivery
   tables, not from logs or Realtime messages;
3. derive liveness from the durable stream-expectation/incident state and
   classify missed cadence without trusting producer-supplied timestamps;
4. read row/byte estimates from the database's metadata or bounded estimates;
5. make the managed-artifact candidate query use the same policy as the
   deletion job; immutable protocol and delivery rows are not candidates for
   this metric;
6. use a monotonic cumulative accounting source for attempts/egress/cost, or
   document reset behavior when counters are reset; and
7. return fixed redacted failure reasons (`authentication`, `timeout`,
   `transport`, `server`, `client`, `signature`, `unknown`). Raw exception
   strings are not valid input to this package.

The exporter endpoint should set `Content-Type: text/plain; version=0.0.4`
and should return the last successful snapshot if a refresh query fails. It
must not turn a database outage into an empty healthy snapshot.

## Operations boundary

This package is a library, not an HTTP server or a database job. The worker,
API, or deployment adapter owns authentication, scrape endpoint exposure,
timeouts, caching, alert rules, and retention of metric snapshots. See the
package-local decision, bug, and learning notes in `docs/`.
