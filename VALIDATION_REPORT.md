# Agent Feed Foundation v0.1.1 validation report

Validated: **2026-08-17**

## Result

**Passed for the integrated Milestone 0/1 candidate.**

- JSON Schemas: 9;
- example begin/batch/event/complete lifecycle reconciled;
- completed zero-finding bundle distinguished from failure/absence;
- hostile bundle retains embedded-instruction and authority-escalation flags;
- finding and evidence contracts remain unverified submissions;
- expected-stream liveness contract validates;
- generated TypeScript and Python protocol artifacts are current;
- protocol `0.1` compatibility checks pass;
- prototype syntax/build checks passed;
- prototype tests: 29/29 passed;
- Milestone 0/1 conformance tests: 23/23 passed;
- PostgreSQL persistence build and tests: 3/3 passed against a disposable live PostgreSQL instance;
- REST health/begin/complete/liveness and security smoke flows passed.

Prototype test coverage includes idempotency, payload-drift rejection, terminal immutability, evidence-reference validation, missed-run incident idempotency and recovery, absent/zero-finding/degraded observations, immutable finding/terminal event payloads, scoped producer authentication, rate limiting, quarantine hooks, hostile flags, and HMAC replay-window/signature verification.

The live PostgreSQL regression suite covers durable begin/batch/complete
idempotency, payload conflicts, atomic evidence references, terminal
immutability, completed-zero semantics, and consumer-owned liveness. CI now
provisions PostgreSQL for this suite. Milestone 2 delivery workers, retries,
acknowledgements, and dead-letter handling remain intentionally unimplemented.
