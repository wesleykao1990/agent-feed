import {
  PostgresDeliveryRepository,
  createAgentFeedPool,
} from "@agent-feed/persistence-postgres";
import type {
  Clock,
  DeliveryRepository,
  DeliveryTransport,
  MetricsSink,
  WorkerRunResult,
} from "@agent-feed/delivery-core";
import type { WebhookTransportOptions } from "@agent-feed/webhook-adapter";
import { createDeliveryWorker, runDeliveryCycle, runDeliveryLoop } from "./composition.ts";
import type { DeliveryKeyResolver } from "./signer.ts";
import { loadFileDeliveryKeyResolver } from "./signing-key-file.ts";

export interface DeliveryRunnerConfig {
  databaseUrl: string;
  signingKeysFile: string;
  tenantId: string;
  consumerId: string;
  workerId: string;
  batchSize: number;
  leaseDurationSeconds: number;
  intervalMs: number;
}

export interface DeliveryRunnerDependencies {
  pool?: ReturnType<typeof createAgentFeedPool>;
  repository?: DeliveryRepository;
  keyResolver?: DeliveryKeyResolver;
  transport?: DeliveryTransport;
  clock?: Clock;
  metrics?: MetricsSink;
  webhook?: WebhookTransportOptions;
}

export interface DeliveryRunnerRuntime {
  worker: ReturnType<typeof createDeliveryWorker>;
  close: () => Promise<void>;
}

/**
 * Compose the durable PostgreSQL repository, protocol signer, safe webhook
 * transport, and lease worker. The runner has no SQL or alternate delivery
 * state machine; all replay/idempotency behavior remains in the existing
 * repository and delivery-core worker.
 */
export async function createDeliveryRunner(
  config: DeliveryRunnerConfig,
  dependencies: DeliveryRunnerDependencies = {},
): Promise<DeliveryRunnerRuntime> {
  const keyResolver = dependencies.keyResolver ?? await loadFileDeliveryKeyResolver(config.signingKeysFile);
  let pool = dependencies.pool;
  if (dependencies.repository === undefined && pool === undefined) pool = createAgentFeedPool(config.databaseUrl);
  let repository: DeliveryRepository;
  if (dependencies.repository !== undefined) repository = dependencies.repository;
  else {
    if (pool === undefined) throw new Error("delivery_repository_required");
    repository = new PostgresDeliveryRepository(pool);
  }
  const worker = createDeliveryWorker({
    repository,
    keyResolver,
    clock: dependencies.clock ?? { now: () => new Date() },
    workerId: config.workerId,
    tenantId: config.tenantId,
    consumerId: config.consumerId,
    batchSize: config.batchSize,
    leaseDurationSeconds: config.leaseDurationSeconds,
    ...(dependencies.transport === undefined ? {} : { transport: dependencies.transport }),
    ...(dependencies.clock === undefined ? {} : { clock: dependencies.clock }),
    ...(dependencies.metrics === undefined ? {} : { metrics: dependencies.metrics }),
    ...(dependencies.webhook === undefined ? {} : { webhook: dependencies.webhook }),
  });
  return {
    worker,
    close: async () => {
      if (dependencies.pool === undefined && pool !== undefined) await pool.end();
    },
  };
}

export async function runDeliveryOnce(worker: ReturnType<typeof createDeliveryWorker>): Promise<WorkerRunResult> {
  return runDeliveryCycle(worker);
}

export async function runDeliveryContinuously(
  worker: ReturnType<typeof createDeliveryWorker>,
  options: {
    signal: AbortSignal;
    intervalMs: number;
    onError?: (error: unknown) => void | Promise<void>;
  },
): Promise<void> {
  await runDeliveryLoop(worker, options);
}

export interface DeliveryRunSummary {
  claimed: number;
  acknowledged: number;
  retryScheduled: number;
  deadLettered: number;
  staleLease: number;
  failed: number;
}

/** Return bounded operational counters without including payloads or secrets. */
export function summarizeDeliveryRun(result: WorkerRunResult): DeliveryRunSummary {
  const summary: DeliveryRunSummary = {
    claimed: result.claimed,
    acknowledged: 0,
    retryScheduled: 0,
    deadLettered: 0,
    staleLease: 0,
    failed: 0,
  };
  for (const item of result.items) {
    if (item.outcome === "acknowledged") summary.acknowledged += 1;
    else if (item.outcome === "retry_scheduled") summary.retryScheduled += 1;
    else if (item.outcome === "dead_lettered") summary.deadLettered += 1;
    else if (item.outcome === "stale_lease") summary.staleLease += 1;
    else if (item.outcome === "failed") summary.failed += 1;
  }
  return summary;
}
