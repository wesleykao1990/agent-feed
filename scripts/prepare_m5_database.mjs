import { migrateAgentFeed } from "../packages/persistence-postgres/src/index.ts";
import { createOperationsPool, migrateOperations } from "../packages/operations-postgres/src/index.ts";

const connectionString = process.env.AGENT_FEED_OPERATIONS_DATABASE_URL ?? process.env.AGENT_FEED_DATABASE_URL;
if (!connectionString) {
  console.error("AGENT_FEED_OPERATIONS_DATABASE_URL or AGENT_FEED_DATABASE_URL is required");
  process.exitCode = 1;
} else {
  const pool = createOperationsPool(connectionString);
  try {
    await migrateAgentFeed(pool);
    await migrateOperations(pool);
    console.log("Prepared the explicit Agent Feed migration chain 0001 -> 0002 -> 0003 -> 0004_operations.");
  } finally {
    await pool.end();
  }
}
