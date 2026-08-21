# Milestone 12 acceptance

Status: **durable persistence and trusted-service checkpoint green locally; milestone not accepted**

- `@agent-feed/utility-feedback-core` clean install and strict build passed;
- 6/6 focused behavioral and adversarial tests passed;
- consumer ownership is injected separately and payload-shaped feedback fails
  closed;
- append retries are idempotent and conflicting rewrites fail;
- exact bounded metrics retain definition and policy scope; and
- prompt/schedule recommendations require separate trusted approval.
- `@agent-feed/utility-feedback-service` strict build and 2/2 trusted-context
  tests passed;
- migration `0007_utility_feedback` applied twice and the complete PostgreSQL
  package suite passed 20/20 against an isolated PostgreSQL instance; and
- direct SQL tampering, cross-tenant targets, conflicting retries, updates, and
  deletes failed closed.

The live Codex credential smoke passed through the machine's cached ChatGPT
login in ephemeral, read-only mode. No credential, prompt response, or model
output is written to the utility ledger. `OPENAI_API_KEY` was not configured in
the process, so the separate API-key probe was correctly reported as skipped.

Hosted CI, bounded aggregate projection, live two-consumer evidence,
independent review, and complete prior-milestone regression remain future
acceptance receipts.
