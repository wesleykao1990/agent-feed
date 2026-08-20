import assert from "node:assert/strict";
import test from "node:test";
import { USAGE_METRICS, type UsageMetric } from "@agent-feed/assessment-core";
import {
  buildProviderConformanceMatrix,
  normalizeProviderConformanceReceipt,
  ProviderConformanceError,
  type ProviderConformanceReceiptInput,
} from "../src/index.ts";

const HASH = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const OTHER_HASH = "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";

function telemetry(observed?: UsageMetric) {
  return USAGE_METRICS.map((metric) => metric === observed
    ? { metric, state: "observed" as const, value: 3, provenance: "executor_measured" as const }
    : { metric, state: "unknown" as const, value: null, provenance: "unknown" as const });
}

function receipt(key: string, provider: string, ingressKind: "manual_export" | "webhook" | "mcp", overrides: Partial<ProviderConformanceReceiptInput> = {}): ProviderConformanceReceiptInput {
  return {
    receiptKey: key,
    logicalJob: { jobKey: "monitor-job", definitionVersion: 2, jobDefinitionHash: HASH, validationPolicyVersionId: "policy-v2" },
    topology: {
      schedulerProvider: `${provider}-scheduler`, executorProvider: provider, ingressKind,
      deploymentBindingHash: provider === "chatgpt" ? HASH : OTHER_HASH,
      capabilityProfileHashes: [HASH],
    },
    executionContext: { adapterKey: `${provider}-adapter`, adapterVersion: "0.1.1", externalInvocationDigest: HASH },
    proofs: { occurrence: "satisfied", execution: "completed", assessment: "passed", delivery: "acknowledged" },
    telemetry: telemetry(provider === "mcp" ? "tool_calls" : undefined),
    ...overrides,
  };
}

test("normalizes a payload-free receipt and preserves explicit unknown telemetry", () => {
  const result = normalizeProviderConformanceReceipt(receipt("chatgpt-receipt", "chatgpt", "manual_export"));
  assert.equal(result.schemaVersion, "agent-feed.provider-conformance.v1");
  assert.equal(result.telemetry.length, USAGE_METRICS.length);
  assert.ok(result.telemetry.every((item) => item.state === "unknown" && item.value === null && item.provenance === "unknown"));
  assert.throws(() => (result.logicalJob as { jobKey: string }).jobKey = "mutated", TypeError);
  assert.throws(() => (result.telemetry as Array<unknown>).push({}), TypeError);
});

test("topology identity is unambiguous when provider keys contain delimiters", () => {
  const first = receipt("delimiter-one", "one", "mcp", {
    topology: { schedulerProvider: "a:b", executorProvider: "c", ingressKind: "mcp", deploymentBindingHash: HASH, capabilityProfileHashes: [HASH] },
  });
  const second = receipt("delimiter-two", "two", "mcp", {
    topology: { schedulerProvider: "a", executorProvider: "b:c", ingressKind: "mcp", deploymentBindingHash: HASH, capabilityProfileHashes: [HASH] },
  });
  const third = receipt("delimiter-three", "three", "webhook");
  assert.equal(buildProviderConformanceMatrix([first, second, third]).topologyCount, 3);
});

test("fails closed on payload fields, raw provider IDs, invalid digests, and invented telemetry", () => {
  const hostile = receipt("hostile", "chatgpt", "manual_export", {
    executionContext: { adapterKey: "chatgpt-adapter", adapterVersion: "0.1.1", externalInvocationDigest: HASH, rawInvocationId: "secret" } as never,
  });
  assert.throws(() => normalizeProviderConformanceReceipt(hostile), /rawInvocationId:unknown_field/u);
  assert.throws(() => normalizeProviderConformanceReceipt(receipt("bad-hash", "chatgpt", "manual_export", {
    logicalJob: { jobKey: "monitor-job", definitionVersion: 2, jobDefinitionHash: "not-a-hash", validationPolicyVersionId: "policy-v2" },
  })), /lowercase_sha256_required/u);
  const invalidTelemetry = telemetry();
  invalidTelemetry[0] = { metric: invalidTelemetry[0]!.metric, state: "unknown", value: 1, provenance: "provider_reported" } as never;
  assert.throws(() => normalizeProviderConformanceReceipt(receipt("invented", "chatgpt", "manual_export", { telemetry: invalidTelemetry })), /null_required|unknown_required/u);
});

test("builds a comparable matrix for three distinct provider topologies", () => {
  const matrix = buildProviderConformanceMatrix([
    receipt("chatgpt-receipt", "chatgpt", "manual_export"),
    receipt("claude-receipt", "claude", "webhook"),
    receipt("mcp-receipt", "mcp", "mcp"),
  ]);
  assert.equal(matrix.topologyCount, 3);
  assert.equal(matrix.logicalJob.jobKey, "monitor-job");
  assert.equal(matrix.telemetryCoverage.tool_calls.observed, 1);
  assert.equal(matrix.telemetryCoverage.input_tokens.unknown, 3);
});

test("rejects logical-job drift, duplicate topology, and incomplete proof layers", () => {
  const first = receipt("one", "chatgpt", "manual_export");
  const second = receipt("two", "claude", "webhook");
  const mismatched = receipt("three", "mcp", "mcp", {
    logicalJob: { jobKey: "other-job", definitionVersion: 2, jobDefinitionHash: HASH, validationPolicyVersionId: "policy-v2" },
  });
  assert.throws(() => buildProviderConformanceMatrix([first, second, mismatched]), /logical_job_identity_mismatch/u);
  assert.throws(() => buildProviderConformanceMatrix([first, { ...first, receiptKey: "duplicate" }, second]), /distinct_topology_minimum_not_met/u);
  assert.throws(() => buildProviderConformanceMatrix([first, second, receipt("three", "mcp", "mcp", {
    proofs: { occurrence: "satisfied", execution: "running", assessment: "passed", delivery: "acknowledged" },
  })]), (error: unknown) => error instanceof ProviderConformanceError && /terminal_comparison_required/u.test(error.message));
});
