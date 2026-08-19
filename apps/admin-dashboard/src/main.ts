import { createAdminDashboardServer } from "./server.ts";
import { JsonFileSnapshotSource } from "./snapshot.ts";

const snapshotPath = process.env.AGENT_FEED_DASHBOARD_SNAPSHOT ?? "runtime/metrics/dashboard.json";
const requestedPort = process.env.AGENT_FEED_DASHBOARD_PORT ?? "8787";
const port = Number(requestedPort);
if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
  console.error("AGENT_FEED_DASHBOARD_PORT must be an integer from 1 to 65535");
  process.exitCode = 2;
} else {
  const server = createAdminDashboardServer({ source: new JsonFileSnapshotSource(snapshotPath) });
  server.listen(port, "127.0.0.1", () => {
    console.log(`Agent Feed dashboard listening on http://127.0.0.1:${port}/`);
  });
}
