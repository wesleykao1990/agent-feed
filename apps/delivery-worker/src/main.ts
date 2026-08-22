import { lstat, readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import {
  createDeliveryRunner,
  runDeliveryContinuously,
  runDeliveryOnce,
  summarizeDeliveryRun,
  type DeliveryRunnerConfig,
} from "./index.ts";

const ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/u;
const DEFAULT_BATCH_SIZE = 10;
const DEFAULT_LEASE_SECONDS = 60;
const DEFAULT_INTERVAL_MS = 1_000;

export class DeliveryCliError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "DeliveryCliError";
    this.code = code;
  }
}

export interface DeliveryCliArguments {
  databaseUrl?: string;
  databaseUrlFile?: string;
  tenantId?: string;
  consumerId?: string;
  workerId?: string;
  signingKeysFile?: string;
  batchSize?: number;
  leaseDurationSeconds?: number;
  intervalMs?: number;
  once: boolean;
  help: boolean;
}

function positiveInteger(value: string, code: string): number {
  if (!/^[1-9][0-9]*$/u.test(value)) throw new DeliveryCliError(code);
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 1) throw new DeliveryCliError(code);
  return result;
}

function requireId(value: string, code: string): string {
  if (!ID_PATTERN.test(value)) throw new DeliveryCliError(code);
  return value;
}

function requirePath(value: string, code: string): string {
  if (value.length === 0 || /[\r\n]/u.test(value)) throw new DeliveryCliError(code);
  return value;
}

export function parseDeliveryArguments(args: readonly string[]): DeliveryCliArguments {
  const result: DeliveryCliArguments = { once: false, help: false };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--help" || argument === "-h") {
      result.help = true;
      continue;
    }
    if (argument === "--once") {
      if (result.once) throw new DeliveryCliError("duplicate_once");
      result.once = true;
      continue;
    }
    if (typeof argument !== "string" || !argument.startsWith("--")) {
      throw new DeliveryCliError("invalid_argument");
    }
    const name = argument.slice(2).replaceAll("-", "_");
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) throw new DeliveryCliError(`missing_${name}`);
    index += 1;
    switch (name) {
      case "database_url": result.databaseUrl = requirePath(value, "invalid_database_url"); break;
      case "database_url_file": result.databaseUrlFile = requirePath(value, "invalid_database_url_file"); break;
      case "tenant_id": result.tenantId = requireId(value, "invalid_tenant_id"); break;
      case "consumer_id": result.consumerId = requireId(value, "invalid_consumer_id"); break;
      case "worker_id": result.workerId = requireId(value, "invalid_worker_id"); break;
      case "signing_keys_file": result.signingKeysFile = requirePath(value, "invalid_signing_keys_file"); break;
      case "batch_size": result.batchSize = positiveInteger(value, "invalid_batch_size"); break;
      case "lease_duration_seconds": result.leaseDurationSeconds = positiveInteger(value, "invalid_lease_duration_seconds"); break;
      case "interval_ms": result.intervalMs = positiveInteger(value, "invalid_interval_ms"); break;
      default: throw new DeliveryCliError(`unknown_${name}`);
    }
  }
  if (result.databaseUrl !== undefined && result.databaseUrlFile !== undefined) {
    throw new DeliveryCliError("database_url_source_conflict");
  }
  return result;
}

async function readPrivateValueFile(filePath: string, code: string): Promise<string> {
  const file = await lstat(filePath).catch(() => null);
  if (file === null || !file.isFile() || file.isSymbolicLink() || file.size === 0 || file.size > 8_192) {
    throw new DeliveryCliError(code);
  }
  if (process.platform !== "win32" && (file.mode & 0o077) !== 0) throw new DeliveryCliError(code);
  try {
    const value = (await readFile(filePath, "utf8")).trim();
    if (value.length === 0 || /[\r\n]/u.test(value)) throw new DeliveryCliError(code);
    return value;
  } catch (error) {
    if (error instanceof DeliveryCliError) throw error;
    throw new DeliveryCliError(code);
  }
}

function envValue(environment: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = environment[name];
  return value === undefined || value === "" ? undefined : value;
}

export async function resolveDeliveryConfig(
  args: DeliveryCliArguments,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<DeliveryRunnerConfig> {
  const databaseUrl = args.databaseUrl
    ?? (args.databaseUrlFile === undefined ? undefined : await readPrivateValueFile(args.databaseUrlFile, "database_url_file_unreadable"))
    ?? envValue(environment, "AGENT_FEED_DATABASE_URL")
    ?? envValue(environment, "DATABASE_URL");
  const signingKeysFile = args.signingKeysFile ?? envValue(environment, "AGENT_FEED_DELIVERY_SIGNING_KEYS_FILE");
  const tenantId = args.tenantId ?? envValue(environment, "AGENT_FEED_DELIVERY_TENANT_ID");
  const consumerId = args.consumerId ?? envValue(environment, "AGENT_FEED_DELIVERY_CONSUMER_ID");
  if (databaseUrl === undefined) throw new DeliveryCliError("database_url_required");
  if (signingKeysFile === undefined) throw new DeliveryCliError("signing_keys_file_required");
  if (tenantId === undefined) throw new DeliveryCliError("tenant_id_required");
  if (consumerId === undefined) throw new DeliveryCliError("consumer_id_required");
  const workerId = args.workerId ?? envValue(environment, "AGENT_FEED_DELIVERY_WORKER_ID") ?? `delivery-worker-${randomUUID()}`;
  return {
    databaseUrl,
    signingKeysFile,
    tenantId: requireId(tenantId, "invalid_tenant_id"),
    consumerId: requireId(consumerId, "invalid_consumer_id"),
    workerId: requireId(workerId, "invalid_worker_id"),
    batchSize: args.batchSize ?? positiveInteger(envValue(environment, "AGENT_FEED_DELIVERY_BATCH_SIZE") ?? String(DEFAULT_BATCH_SIZE), "invalid_batch_size"),
    leaseDurationSeconds: args.leaseDurationSeconds ?? positiveInteger(envValue(environment, "AGENT_FEED_DELIVERY_LEASE_SECONDS") ?? String(DEFAULT_LEASE_SECONDS), "invalid_lease_duration_seconds"),
    intervalMs: args.intervalMs ?? positiveInteger(envValue(environment, "AGENT_FEED_DELIVERY_INTERVAL_MS") ?? String(DEFAULT_INTERVAL_MS), "invalid_interval_ms"),
  };
}

export function usage(): string {
  return `Agent Feed durable delivery worker

Usage:
  npm start -- [--once] [--database-url URL | --database-url-file PATH]
               [--tenant-id ID] [--consumer-id ID] [--worker-id ID]
               [--signing-keys-file PATH] [--batch-size N]
               [--lease-duration-seconds N] [--interval-ms N]

The worker claims eligible rows from the configured durable subscription,
signs protocol 0.1 events, sends them through the existing safe webhook
transport, and records acknowledgement/retry/dead-letter state. Terminal
events (run.completed, run.partial, and run.failed) are delivered when the
subscription selects them. --once performs one bounded recovery-and-claim
cycle for local operations.

Signing-key file format (keep the file owner-only):
  { "subscription-key-reference": { "secret": "..." } }

Environment equivalents:
  AGENT_FEED_DATABASE_URL, AGENT_FEED_DELIVERY_SIGNING_KEYS_FILE,
  AGENT_FEED_DELIVERY_TENANT_ID, AGENT_FEED_DELIVERY_CONSUMER_ID,
  AGENT_FEED_DELIVERY_WORKER_ID, AGENT_FEED_DELIVERY_BATCH_SIZE,
  AGENT_FEED_DELIVERY_LEASE_SECONDS, AGENT_FEED_DELIVERY_INTERVAL_MS`;
}

function safeErrorCode(error: unknown): string {
  if (error instanceof DeliveryCliError) return error.code;
  return "delivery_worker_failed";
}

export async function runDeliveryCli(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  let parsed: DeliveryCliArguments;
  try {
    parsed = parseDeliveryArguments(argv);
    if (parsed.help) {
      process.stdout.write(`${usage()}\n`);
      return 0;
    }
    const config = await resolveDeliveryConfig(parsed);
    const runtime = await createDeliveryRunner(config);
    const controller = new AbortController();
    let cycleFailed = false;
    const onSignal = (): void => controller.abort();
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
    try {
      if (parsed.once) {
        const result = await runDeliveryOnce(runtime.worker);
        process.stdout.write(`${JSON.stringify(summarizeDeliveryRun(result))}\n`);
        return 0;
      }
      await runDeliveryContinuously(runtime.worker, {
        signal: controller.signal,
        intervalMs: config.intervalMs,
        onError: async () => {
          cycleFailed = true;
          process.stderr.write("delivery_worker_cycle_failed\n");
          controller.abort();
        },
      });
      return cycleFailed ? 1 : 0;
    } finally {
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
      await runtime.close();
    }
  } catch (error) {
    process.stderr.write(`${safeErrorCode(error)}\n`);
    return 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void runDeliveryCli().then((code) => {
    process.exitCode = code;
  });
}
