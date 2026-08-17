# Agent Feed Foundation v0.1.1 validation report

Validated: **2026-08-17**

## Result

**Passed.**

- JSON Schemas: 9;
- example begin/batch/event/complete lifecycle reconciled;
- completed zero-finding bundle distinguished from failure/absence;
- hostile bundle retains embedded-instruction and authority-escalation flags;
- finding and evidence contracts remain unverified submissions;
- expected-stream liveness contract validates;
- prototype syntax/build checks passed;
- prototype tests: 8/8 passed;
- REST health/begin/complete/liveness smoke flow passed.

Prototype test coverage includes idempotency, payload-drift rejection, terminal immutability, evidence-reference validation, missed-run detection, degraded partial-run state, hostile flags, and HMAC replay-window rejection.

The reference PostgreSQL schema received structural validation only in this packaging environment.
