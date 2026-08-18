import type {
  ProducerService,
  ProducerServiceError,
  ProducerAuthenticationRequest,
  ProducerPrincipal,
  RunRecord,
} from "@agent-feed/producer-service";

/** JSON-RPC request identifiers accepted by the MCP stdio transport. */
export type JsonRpcId = string | number;

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: JsonRpcId;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcErrorBody {
  code: number;
  message: string;
  data?: Record<string, unknown>;
}

export interface JsonRpcErrorResponse {
  jsonrpc: "2.0";
  id: JsonRpcId | null;
  error: JsonRpcErrorBody;
}

export interface JsonRpcSuccessResponse {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result: Record<string, unknown>;
}

export type JsonRpcResponse = JsonRpcErrorResponse | JsonRpcSuccessResponse;

export interface McpTextContent {
  type: "text";
  text: string;
}

export interface McpToolCallResult {
  content: readonly McpTextContent[];
  isError?: boolean;
  structuredContent?: unknown;
}

export interface McpToolDescriptor {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: Record<string, unknown>;
}

/**
 * The smallest structural surface the MCP adapter consumes from the producer
 * application service. The concrete `ProducerService` satisfies this shape;
 * keeping it structural makes unit tests and alternate compositions simple
 * without creating a second lifecycle policy implementation.
 */
export interface ProducerServiceBoundary {
  beginRun(value: unknown, principal: ProducerPrincipal): Promise<RunRecord | unknown>;
  submitBatch(runId: string, value: unknown, principal: ProducerPrincipal): Promise<RunRecord | unknown>;
  completeRun(runId: string, value: unknown, principal: ProducerPrincipal): Promise<RunRecord | unknown>;
  authenticate?(request: ProducerAuthenticationRequest): ProducerPrincipal;
  assertRateAllowed?(principal: ProducerPrincipal): unknown;
  security?: {
    max_body_bytes?: number;
  };
}

/** A concrete service remains assignable to the public boundary. */
export type ProducerApplicationService = ProducerService & ProducerServiceBoundary;

export interface McpServerOptions {
  /** The already-composed producer application service. */
  service: ProducerServiceBoundary;
  /** Trusted test/in-process composition principal; never accepted from tool arguments. */
  principal?: ProducerPrincipal;
  /** Alias for callers that name the injected auth result explicitly. */
  auth_principal?: ProducerPrincipal;
  /** JavaScript-style alias for `auth_principal`. */
  authPrincipal?: ProducerPrincipal;
  /** Bearer value used only when `principal` is not injected. */
  authorization?: string;
  server_name?: string;
  server_version?: string;
  /** Tighten the service body limit for a deployment or deterministic tests. */
  max_argument_bytes?: number;
}

/** @internal Legacy fixture transport surface. */
export interface McpServerTransport {
  start(input?: NodeJS.ReadableStream, output?: NodeJS.WritableStream): Promise<void>;
}

/** @internal Legacy fixture surface; production uses the official SDK Server. */
export interface McpStdioServer extends McpServerTransport {
  handleMessage(message: unknown): Promise<JsonRpcResponse | null>;
}

export type SafeProducerServiceError = Pick<ProducerServiceError, "code" | "status" | "retry_after_seconds">;
