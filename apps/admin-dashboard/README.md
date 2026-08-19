# Agent Feed admin dashboard reference

This is an optional, read-only operations view for Milestone 5. It presents a
small sanitized metric snapshot and does not replace the delivery queue,
PostgreSQL, or an operational API. It works without Supabase Realtime: the
dashboard reads one aggregate at request time and marks it stale when its
freshness window has elapsed.

## Run locally

From this directory, with Node 22 or newer:

```sh
npm install
npm run build
npm test
AGENT_FEED_DASHBOARD_SNAPSHOT=/path/to/dashboard.json npm start
```

The process binds to `127.0.0.1` and serves the page at
`http://127.0.0.1:8787/`. Set `AGENT_FEED_DASHBOARD_PORT` to choose another
local port. The default snapshot path is
`runtime/metrics/dashboard.json`.

The server also enforces loopback access at the request boundary. If a
deployment intentionally listens on a non-loopback interface, it must inject
an `authorize(request)` function into `createAdminDashboardServer`; requests
are otherwise denied without revealing whether a route exists. The dashboard
never accepts credentials in a query string. Deployment authentication should
use an authorization header or an external session guard, plus TLS and network
policy.

Example snapshot (all fields are required):

```json
{
  "schemaVersion": 1,
  "generatedAt": "2026-08-18T00:10:00.000Z",
  "freshnessWindowSeconds": 120,
  "metrics": {
    "pending_events": 0,
    "oldest_pending_age_seconds": 0,
    "active_leases": 1,
    "expired_leases": 0,
    "dead_letters_total": 0,
    "delivery_attempts_total": 42,
    "overdue_streams": 0,
    "retention_eligible_artifacts": 0
  }
}
```

## Integration boundary

`DashboardSnapshotSource` is the only source boundary. An operations exporter
may implement `read()` using a database query, an authenticated API request,
or a local snapshot file, but it must publish the v1 aggregate above. The
dashboard validates the result, bounds file size and numeric values, never
renders raw source content, and never accepts credentials through the browser.
The `@agent-feed/operations-observability` package owns the metric-name and
label allowlists and canonical family shape. A deployment adapter still owns
authentication, tenant/consumer authorization, aggregation, caching, and
snapshot publication. It should depend on this contract rather than having the
dashboard reach into database tables.

An operations exporter can map its canonical `MetricSnapshot` with
`metricSnapshotToDashboardSnapshot` or `MetricSnapshotDashboardSource`. The
adapter requires the exact Agent Feed family order, names, types, HELP text,
sample counts, and fixed labels. In particular, `overdue_streams` is selected
only from `agent_feed_liveness_streams{state="overdue"}`; missing, duplicate,
or relabelled families are rejected before rendering.

The API exposes only `GET /api/snapshot` and returns a stable status of
`ready`, `empty`, or `error`; it has no mutation routes. Deployments should put
authentication and network policy in front of it. This reference intentionally
does not claim production hosting or account-side configuration.

## Safety and accessibility

- The HTML is server-rendered with constant labels and escaped dynamic values.
- A restrictive content-security policy, no scripts, no forms, and no external
  assets are used in the reference page.
- Empty, invalid, unavailable, and stale source states are visible and use
  `role="status"` or `role="alert"`.
- Cards have text labels, numeric `aria-label` values, keyboard-visible links,
  responsive layout, and light/dark color-scheme support.
- This is an operations reference, not an authorization boundary. Keep it
  private and require deployment-level authentication.
