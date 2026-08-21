# Large-run scaling refactor debt

No refactor of protocol, persistence, producer service, or transport is needed
for the TypeScript checkpoint. The planner is isolated from consumer and
domain code, and `submitLargeRun` composes the existing accepted single-batch
method.

Open follow-ups:

- add Python SDK parity after the TypeScript contract is stable;
- run an authorized 44-family durable REST/PostgreSQL rehearsal;
- measure rate limiting, database latency, delivery backlog, and restart time;
- prove shared rate limiting before multi-replica ingress; and
- reconsider hierarchical parent/child work only if measured batches are not
  sufficient.
