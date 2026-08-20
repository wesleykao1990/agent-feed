import assert from "node:assert/strict";
import test from "node:test";
import {
  evaluateActivationPreflight,
  hashJobDefinition,
  normalizeCapabilityProfile,
  normalizeDeploymentBinding,
  normalizeJobDefinition,
  type DeploymentBindingInput,
  type JobDefinitionInput,
} from "../src/index.ts";

const HASH = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const job = (overrides: Partial<JobDefinitionInput> = {}): JobDefinitionInput => ({
  jobKey: "daily-monitor",
  version: 1,
  ownerId: "owner-team",
  lifecycleState: "active",
  instructions: { digest: HASH, controlledReference: "git+https://example.test/repo@abc123/prompt.md" },
  validationPolicyVersionId: "policy-v1",
  requiredCapabilities: [{ key: "scheduled_invocation", minimumVersion: "1.2", role: "scheduler" }],
  outputContracts: [{ contractKey: "finding-bundle", version: "1", sha256: HASH }],
  budgets: [{ budgetKey: "tokens", limit: 1000, unit: "tokens" }],
  ...overrides,
});
const binding = (overrides: Partial<DeploymentBindingInput> = {}): DeploymentBindingInput => ({
  bindingKey: "prod",
  version: 1,
  jobDefinitionId: "daily-monitor:1",
  activationState: "active",
  topology: { schedulerProvider: "provider-a", executorProvider: "provider-b", ingressKind: "mcp" },
  capabilityProfiles: [{ profileKey: "provider-a", version: 1, providerKey: "provider-a", capabilities: [{ key: "scheduled_invocation", version: "1.3", role: "scheduler", available: true }] }],
  offSwitchReference: "config://agent-feed/off-switch/daily-monitor",
  shadowEvidence: [{ assessmentId: "assessment-1", verdict: "passed", independence: "independent" }],
  ...overrides,
});

test("normalization is deterministic and job identity survives topology moves", () => {
  const normalized = normalizeJobDefinition(job({ requiredCapabilities: [
    { key: "remote_mcp", minimumVersion: "1", role: "ingress" },
    { key: "scheduled_invocation", minimumVersion: "1.2", role: "scheduler" },
  ] }));
  assert.equal(normalized.jobKey, "daily-monitor");
  assert.equal(normalized.requiredCapabilities[0]?.role, "ingress");
  const moved = normalizeDeploymentBinding(binding({ topology: { schedulerProvider: "provider-c", executorProvider: "provider-d", ingressKind: "rest" } }));
  assert.equal(moved.jobDefinitionId, "daily-monitor:1");
});

test("compatible active deployment passes exact pinned capability preflight", () => {
  const result = evaluateActivationPreflight(job(), binding());
  assert.equal(result.compatible, true);
  assert.deepEqual(result.reasons, ["compatible"]);
  assert.equal(result.capabilityGaps.length, 0);
});

test("incompatible capability version fails before activation", () => {
  const result = evaluateActivationPreflight(job(), binding({ capabilityProfiles: [{ profileKey: "provider-a", version: 1, providerKey: "provider-a", capabilities: [{ key: "scheduled_invocation", version: "1.1", role: "scheduler", available: true }] }] }));
  assert.equal(result.compatible, false);
  assert.deepEqual(result.reasons, ["incompatible_capability"]);
  assert.equal(result.capabilityGaps[0]?.reason, "version");
});

test("autonomous activation requires policy, budget, off-switch, and shadow evidence", () => {
  const result = evaluateActivationPreflight(job({ validationPolicyVersionId: null, budgets: [] }), binding({ offSwitchReference: null, shadowEvidence: [] }));
  assert.equal(result.compatible, false);
  assert.deepEqual(result.reasons, ["missing_budget", "missing_off_switch", "missing_shadow_evidence", "missing_validation_policy"]);
});

test("definitions and metadata reject secrets, inline content, unsafe references, and floats", () => {
  assert.throws(() => normalizeJobDefinition(job({ metadata: { apiToken: "not-allowed" } })), /sensitive_key/);
  assert.throws(() => normalizeJobDefinition(job({ metadata: { ratio: 1.5 } })), /safe_integer/);
  assert.throws(() => normalizeJobDefinition(job({ instructions: { digest: HASH, controlledReference: "https://example.test/prompt?token=x" } })), /controlled_reference/);
  assert.throws(() => normalizeCapabilityProfile({ profileKey: "p", version: 1, providerKey: "p", metadata: { content: "prompt bytes" } }), /sensitive_key/);
});

test("canonical hashing ignores set order but changes with job definition", () => {
  const first = hashJobDefinition(job({ requiredCapabilities: [
    { key: "z", minimumVersion: "1", role: "executor" }, { key: "a", minimumVersion: "1", role: "scheduler" },
  ] }));
  const second = hashJobDefinition(job({ requiredCapabilities: [
    { key: "a", minimumVersion: "1", role: "scheduler" }, { key: "z", minimumVersion: "1", role: "executor" },
  ] }));
  assert.equal(first, second);
  assert.notEqual(first, hashJobDefinition(job({ ownerId: "other-owner" })));
});
