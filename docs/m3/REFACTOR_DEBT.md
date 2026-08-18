# Milestone 3 modularity and refactor-debt audit

Reviewed: 2026-08-18
Status: final review complete; hosted CI green

## Intended ownership

| Boundary | Responsibility | Forbidden dependency |
|---|---|---|
| `apps/mcp-server` | MCP framing, tool declarations, principal/composition wiring, error mapping | SQL and persistence implementation imports in handlers |
| `packages/sdk/typescript` | Typed producer/consumer clients and transports | Server application and database internals |
| `packages/sdk/python` | Python producer/consumer clients and protocol models | Repository-specific server or database code |
| `packages/adapters/*` | External format/event translation and failure preservation | Direct persistence and duplicated lifecycle policy |
| `skills/*` | Accurate agent operating instructions | Claims about unavailable runtime capabilities |
| `@agent-feed/producer-service` | Producer validation, authorization, security, and lifecycle policy | Concrete transport behavior |

## Final verdict

Milestone 3 fits the accepted Milestone 0-2 graph without a foundational or
immediate follow-up refactor. Routing duplication found during integration was
removed before acceptance. Lifecycle policy remains in the producer service;
transports handle framing, authentication input, and error mapping. The M3
architecture/conformance gate and the complete M0-M2 regression are green.

## Final review checklist

- [x] No production import uses another package's `/src` subpath.
- [x] No MCP handler, SDK, skill, or adapter imports PostgreSQL; only the MCP
  executable composition root constructs the approved persistence adapter.
- [x] REST and MCP delegate to the same public producer service.
- [x] SDK retry policy is bounded and idempotency-aware.
- [x] Adapter failure after begin closes or emits deterministic recovery data.
- [x] Tool-less and capability-absent exports validate against protocol `0.1`.
- [x] No new package requires immediate extraction or circular-dependency repair.
- [x] All package READMEs match executable behavior and deployment status.

## Non-blocking operational follow-up

- Choose and operate the access-controlled recovery store for deployments that
  cannot immediately close failed runs.
- Inject a durable atomic webhook replay store in multi-process or
  restart-sensitive deployments; the built-in claim map is process-local.
- Persist or reconstruct Claude hook correlation state when the hook producer
  can restart between lifecycle events; the package keeps process-local state.
- Configure concrete consumer transports only where a consumer API is actually
  deployed; the SDK intentionally does not invent one.
- Add package registry publication workflows if the SDKs are promoted from
  repository artifacts to public releases.
- Preserve the current MCP dependency pin and rerun modern/legacy conformance
  before any MCP SDK upgrade.
