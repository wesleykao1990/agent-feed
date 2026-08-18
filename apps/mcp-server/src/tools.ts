import { schemas } from "@agent-feed/schema";
import type { McpToolDescriptor } from "./types.ts";

export const MCP_TOOL_NAMES = Object.freeze([
  "begin_run",
  "submit_batch",
  "complete_run",
] as const);

export type McpToolName = (typeof MCP_TOOL_NAMES)[number];

function copySchema(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("published_tool_schema_must_be_an_object");
  }
  // Tool descriptors are exposed to an untrusted client. Return a copy so a
  // caller cannot mutate the schema object cached by @agent-feed/schema.
  return structuredClone(value) as Record<string, unknown>;
}

const annotations = Object.freeze({
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
});

export const MCP_TOOL_DEFINITIONS: readonly McpToolDescriptor[] = Object.freeze([
  {
    name: "begin_run",
    description: "Create or return an idempotent running Agent Feed run envelope. Protocol and producer scope are validated by the producer application service.",
    inputSchema: copySchema(schemas.beginRun),
    annotations,
  },
  {
    name: "submit_batch",
    description: "Atomically accept a bounded, idempotent batch of untrusted findings and submitted evidence for a running Agent Feed run.",
    inputSchema: copySchema(schemas.submitBatch),
    annotations,
  },
  {
    name: "complete_run",
    description: "Close an Agent Feed run with a terminal status, actual scope, statistics, and bounded errors. Completion is idempotent and immutable.",
    inputSchema: copySchema(schemas.completeRun),
    annotations,
  },
]);

export function toolDescriptor(name: McpToolName): McpToolDescriptor {
  const descriptor = MCP_TOOL_DEFINITIONS.find((item) => item.name === name);
  if (!descriptor) throw new Error("unknown_mcp_tool");
  return structuredClone(descriptor) as McpToolDescriptor;
}
