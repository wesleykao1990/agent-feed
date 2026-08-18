import type {
  BeginRunRequest,
  CompleteRunRequest,
  RunBundle,
  SubmitBatchRequest,
} from "../generated/protocol.ts";
import {
  AgentFeedClient,
  type AgentFeedClientOptions,
  type AgentFeedRequestOptions,
} from "./client.ts";
import { AgentFeedResponseError } from "./errors.ts";
import type {
  ProducerFindingsResponse,
  ProducerFindingResponse,
  ProducerRunResponse,
} from "./types.ts";

export type ProducerClientOptions = AgentFeedClientOptions;

export interface ProducerFindingsOptions extends AgentFeedRequestOptions {}

function segment(value: string, field: string): string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) throw new Error(`${field}_invalid`);
  return encodeURIComponent(value);
}

function record(value: unknown, operation: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new AgentFeedResponseError({ operation });
  return value as Record<string, unknown>;
}

function runResponse(value: unknown, operation: string): ProducerRunResponse {
  const result = record(value, operation);
  if (typeof result.run_id !== "string" || result.run_id.length === 0) throw new AgentFeedResponseError({ operation });
  return result as ProducerRunResponse;
}

function findingsResponse(value: unknown, operation: string): ProducerFindingsResponse {
  const result = record(value, operation);
  if (typeof result.run_id !== "string" || result.run_id.length === 0 || !Array.isArray(result.findings)) {
    throw new AgentFeedResponseError({ operation });
  }
  return result as unknown as ProducerFindingsResponse;
}

function bundleIdentity(runId: string, batches: readonly SubmitBatchRequest[], complete: CompleteRunRequest): void {
  if (runId.length < 8) throw new Error("run_id_invalid");
  if (complete.run_id !== runId) throw new Error("complete_run_id_mismatch");
  if (batches.some((batch) => batch.run_id !== runId)) throw new Error("batch_run_id_mismatch");
}

/**
 * REST producer client for protocol `0.1`.
 *
 * The request objects are the generated wire types; the SDK does not
 * translate them to a second camelCase contract. Mutating calls are retried
 * only because each generated request carries its idempotency key.
 */
export class ProducerClient extends AgentFeedClient {
  constructor(options: ProducerClientOptions) {
    super(options);
  }

  async beginRun(input: BeginRunRequest, options: AgentFeedRequestOptions = {}): Promise<ProducerRunResponse> {
    const operation = "producer.begin_run";
    const body = await this.requestJson<unknown>({
      operation,
      method: "POST",
      path: "/v1/runs:begin",
      body: input,
      expected_status: new Set([201]),
      idempotency_keyed: true,
    }, options);
    return runResponse(body, operation);
  }

  async submitBatch(
    runId: string,
    input: SubmitBatchRequest,
    options: AgentFeedRequestOptions = {},
  ): Promise<ProducerRunResponse> {
    const operation = "producer.submit_batch";
    const body = await this.requestJson<unknown>({
      operation,
      method: "POST",
      path: `/v1/runs/${segment(runId, "run_id")}/batches`,
      body: input,
      expected_status: new Set([202]),
      idempotency_keyed: true,
    }, options);
    return runResponse(body, operation);
  }

  async completeRun(
    runId: string,
    input: CompleteRunRequest,
    options: AgentFeedRequestOptions = {},
  ): Promise<ProducerRunResponse> {
    const operation = "producer.complete_run";
    const body = await this.requestJson<unknown>({
      operation,
      method: "POST",
      path: `/v1/runs/${segment(runId, "run_id")}:complete`,
      body: input,
      expected_status: new Set([200]),
      idempotency_keyed: true,
    }, options);
    return runResponse(body, operation);
  }

  async getRun(runId: string, options: AgentFeedRequestOptions = {}): Promise<ProducerRunResponse> {
    const operation = "producer.get_run";
    const body = await this.requestJson<unknown>({
      operation,
      method: "GET",
      path: `/v1/runs/${segment(runId, "run_id")}`,
      expected_status: new Set([200]),
      idempotent: true,
    }, options);
    return runResponse(body, operation);
  }

  async getFindings(runId: string, options: ProducerFindingsOptions = {}): Promise<ProducerFindingsResponse> {
    const operation = "producer.get_findings";
    const body = await this.requestJson<unknown>({
      operation,
      method: "GET",
      path: `/v1/runs/${segment(runId, "run_id")}/findings`,
      expected_status: new Set([200]),
      idempotent: true,
    }, options);
    return findingsResponse(body, operation);
  }

  /** Alias matching the route's plural resource name. */
  getRunFindings(runId: string, options: ProducerFindingsOptions = {}): Promise<ProducerFindingsResponse> {
    return this.getFindings(runId, options);
  }

  /** Build an importable, schema-typed bundle without making a network call. */
  buildRunBundle(
    runId: string,
    begin: BeginRunRequest,
    batches: readonly SubmitBatchRequest[],
    complete: CompleteRunRequest,
  ): RunBundle {
    if (typeof runId !== "string" || runId.length === 0 || runId.trim() !== runId) throw new Error("run_id_invalid");
    bundleIdentity(runId, batches, complete);
    return {
      protocol_version: "0.1",
      begin: structuredClone(begin),
      batches: structuredClone([...batches]),
      complete: structuredClone(complete),
      run_id: runId,
    };
  }
}

export { ProducerClient as AgentFeedProducerClient };

export function createRunBundle(
  runId: string,
  begin: BeginRunRequest,
  batches: readonly SubmitBatchRequest[],
  complete: CompleteRunRequest,
): RunBundle {
  // The helper is intentionally independent of a client instance so an agent
  // without network capability can still create a portable import artifact.
  if (typeof runId !== "string" || runId.length === 0 || runId.trim() !== runId) throw new Error("run_id_invalid");
  bundleIdentity(runId, batches, complete);
  return {
    protocol_version: "0.1",
    begin: structuredClone(begin),
    batches: structuredClone([...batches]),
    complete: structuredClone(complete),
    run_id: runId,
  };
}

export type { ProducerFindingsResponse, ProducerFindingResponse, ProducerRunResponse };
