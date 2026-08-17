import {
  DeliveryWorker,
  type Clock,
  type DeliveryRepository,
  type DeliverySigner,
  type DeliveryTransport,
  type MetricsSink,
  type RetryPolicy,
  type WorkerOptions,
  type WorkerRunResult,
} from "@agent-feed/delivery-core";
import { WebhookTransport, type WebhookTransportOptions } from "@agent-feed/webhook-adapter";
import { ProtocolDeliverySigner, type DeliveryKeyResolver } from "./signer.ts";
import { WebhookRetryPolicy, type WebhookRetryPolicyOptions } from "./retry-policy.ts";

export interface DeliveryWorkerCompositionOptions extends Omit<WorkerOptions, "signer" | "transport" | "retryPolicy"> {
  keyResolver: DeliveryKeyResolver;
  signer?: DeliverySigner;
  transport?: DeliveryTransport;
  retryPolicy?: RetryPolicy;
  webhook?: WebhookTransportOptions;
  webhookRetry?: WebhookRetryPolicyOptions;
}

export function createDeliveryWorker(options: DeliveryWorkerCompositionOptions): DeliveryWorker {
  const signer = options.signer ?? new ProtocolDeliverySigner({ keyResolver: options.keyResolver });
  const transport = options.transport ?? new WebhookTransport(options.webhook);
  const retryPolicy = options.retryPolicy ?? new WebhookRetryPolicy(options.webhookRetry);
  return new DeliveryWorker({
    repository: options.repository,
    clock: options.clock,
    workerId: options.workerId,
    signer,
    transport,
    retryPolicy,
    ...(options.metrics === undefined ? {} : { metrics: options.metrics }),
    ...(options.tenantId === undefined ? {} : { tenantId: options.tenantId }),
    ...(options.consumerId === undefined ? {} : { consumerId: options.consumerId }),
    ...(options.batchSize === undefined ? {} : { batchSize: options.batchSize }),
    ...(options.leaseDurationSeconds === undefined ? {} : { leaseDurationSeconds: options.leaseDurationSeconds }),
  });
}

export async function runDeliveryCycle(worker: DeliveryWorker): Promise<WorkerRunResult> {
  await worker.recoverExpiredLeases();
  return worker.runOnce();
}

export interface DeliveryLoopOptions {
  signal?: AbortSignal;
  intervalMs?: number;
  onError?: (error: unknown) => void | Promise<void>;
  sleep?: (milliseconds: number) => Promise<void>;
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    const onAbort = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** Run cycles until aborted; no process/global signal handlers are installed. */
export async function runDeliveryLoop(worker: DeliveryWorker, options: DeliveryLoopOptions = {}): Promise<void> {
  const signal = options.signal ?? new AbortController().signal;
  const intervalMs = options.intervalMs ?? 1000;
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 0) throw new Error("invalid_delivery_loop_interval");
  while (!signal.aborted) {
    try {
      await runDeliveryCycle(worker);
    } catch (error) {
      if (options.onError === undefined) throw error;
      await options.onError(error);
    }
    if (signal.aborted) break;
    if (options.sleep) await options.sleep(intervalMs);
    else await delay(intervalMs, signal);
  }
}

export type DeliveryWorkerRuntimeDependencies = {
  repository: DeliveryRepository;
  clock: Clock;
  metrics?: MetricsSink;
};
