import { createAgentFeedPool, migrateAgentFeed, PostgresAgentFeedPersistence } from "@agent-feed/persistence-postgres";
import {
  ProducerService,
  StaticProducerAuthenticator,
  type ProducerCredential,
} from "@agent-feed/producer-service";
import { createAgentFeedApiServer } from "./index.ts";

function credentialsFromEnvironment(): ProducerCredential[] {
  const raw = process.env.AGENT_FEED_PRODUCER_CREDENTIALS;
  if (raw) {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) throw new Error("AGENT_FEED_PRODUCER_CREDENTIALS must be a JSON array");
    return value as ProducerCredential[];
  }
  const tenant = process.env.AGENT_FEED_TENANT_ID;
  const producer = process.env.AGENT_FEED_PRODUCER_ID;
  const secret = process.env.AGENT_FEED_PRODUCER_SECRET;
  const streams = (process.env.AGENT_FEED_ALLOWED_STREAMS ?? "").split(",").map((item) => item.trim()).filter(Boolean);
  if (!tenant || !producer || !secret || streams.length === 0) {
    throw new Error("configure AGENT_FEED_PRODUCER_CREDENTIALS or the AGENT_FEED_TENANT_ID/PRODUCER_ID/PRODUCER_SECRET/ALLOWED_STREAMS variables");
  }
  return [{ tenant_id: tenant, producer_id: producer, secret, allowed_stream_ids: streams }];
}

async function main(): Promise<void> {
  const pool = createAgentFeedPool();
  try {
    await migrateAgentFeed(pool);
    const persistence = new PostgresAgentFeedPersistence(pool);
    const service = new ProducerService({
      persistence,
      authenticator: new StaticProducerAuthenticator(credentialsFromEnvironment()),
    });
    const server = createAgentFeedApiServer({ service });
    const port = Number(process.env.PORT ?? 7071);
    const host = process.env.HOST ?? "127.0.0.1";
    server.listen(port, host, () => console.log(`Agent Feed API: http://${host}:${port}`));
    const shutdown = async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await pool.end();
    };
    process.once("SIGINT", () => void shutdown());
    process.once("SIGTERM", () => void shutdown());
  } catch (error) {
    await pool.end();
    throw error;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) void main();
