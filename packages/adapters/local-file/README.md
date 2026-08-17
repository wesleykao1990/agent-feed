# Local-file run-bundle adapter

This adapter is the durable fallback for producers that cannot call the Agent
Feed REST API, MCP, or a webhook. It reads a JSON run bundle, validates the
protocol `0.1` `run-bundle` contract from `@agent-feed/schema`, and delegates
the lifecycle to an injected `ProducerService` boundary.

The adapter never owns SQL, persistence, authentication, or an in-memory store.
The injected principal and service determine the producer scope; in production
the service is composed with `PostgresAgentFeedPersistence`.

```ts
import { LocalFileRunBundleAdapter } from "@agent-feed/local-file-adapter";

const adapter = new LocalFileRunBundleAdapter({
  service: producerService,
  principal: authenticatedProducer,
});

const result = await adapter.importFile("./run-bundle.json");
```

Import order is deterministic: `beginRunWithWireId(bundle.run_id, begin)`,
then every batch in array order, then `completeRun`. Exact retries are delegated
to the durable service's idempotency contract. The bundle's producer-visible
`run_id` is passed unchanged, including non-UUID IDs; the adapter does not
silently replace it with a generated UUID.
