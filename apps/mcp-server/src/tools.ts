import { schemas } from "@agent-feed/schema";
import type { McpToolDescriptor } from "./types.ts";

export const MCP_TOOL_NAMES = Object.freeze([
  "begin_run",
  "submit_batch",
  "complete_run",
  "submit_bounded_run",
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

function withoutRunId(value: unknown): Record<string, unknown> {
  const schema = copySchema(value);
  if (schema.properties !== null && typeof schema.properties === "object" && !Array.isArray(schema.properties)) {
    delete (schema.properties as Record<string, unknown>).run_id;
  }
  if (Array.isArray(schema.required)) {
    schema.required = schema.required.filter((item) => item !== "run_id");
  }
  delete schema.$id;
  return schema;
}

const boundedRunSchema: Record<string, unknown> = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://agent-feed.dev/schemas/submit-bounded-run.schema.json",
  type: "object",
  additionalProperties: false,
  required: ["begin", "batches", "complete"],
  properties: {
    begin: copySchema(schemas.beginRun),
    batches: {
      type: "array",
      items: withoutRunId(schemas.submitBatch),
      maxItems: 100,
    },
    complete: withoutRunId(schemas.completeRun),
  },
};

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
  {
    name: "submit_bounded_run",
    description: "Run an interruption-safe bounded lifecycle in one MCP call: begin an idempotent run, submit zero or more idempotent batches, then complete it. The returned run_id is injected server-side into every batch and completion record; replaying the same request is safe when its component idempotency keys are unchanged.",
    inputSchema: copySchema(boundedRunSchema),
    annotations,
  },
]);

export function toolDescriptor(name: McpToolName): McpToolDescriptor {
  const descriptor = MCP_TOOL_DEFINITIONS.find((item) => item.name === name);
  if (!descriptor) throw new Error("unknown_mcp_tool");
  return structuredClone(descriptor) as McpToolDescriptor;
}
