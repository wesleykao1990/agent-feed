# Observability learnings

## M5O-L001 — Bounded labels are easier to prove when they are not inputs

Allowlisting labels in a generic `MetricsSink` still leaves every composition
root responsible for configuring the allowlist. A snapshot API with only fixed
enum maps makes arbitrary tenant IDs, URLs, source titles, and error strings
unrepresentable at the package boundary.

## M5O-L002 — A zero is different from a missing scrape

When a query returns a valid empty queue, the exporter should emit zero-valued
families. When the query fails, returning an empty snapshot would falsely
report a healthy system. The adapter must keep the last good sample and expose
refresh failure separately.

## M5O-L003 — Liveness is a state count, not a stream label

Operators need to know whether streams are healthy or overdue, but a stream or
producer identifier is usually unnecessary for the top-level scrape and
creates high-cardinality series. Drill-down can use an authenticated audit
query outside the Prometheus label path.

## M5O-L004 — A TypeScript interface is not a runtime trust boundary

Snapshots can be forged by JavaScript callers or altered after serialization.
An exporter must validate its final structured input before interpolating
names, HELP text, labels, or numbers into a line protocol. Centralizing the
canonical family definitions lets collection and rendering share one
allowlist without accepting arbitrary snapshot text.
