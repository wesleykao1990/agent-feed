import { createInterface } from "node:readline";
import {
  McpProtocolError,
  invalidParams,
  invalidRequest,
  internalError,
  jsonRpcError,
  methodNotFound,
  parseError,
  serverNotInitialized,
  unsupportedProtocolVersion,
} from "./errors.ts";
import { LifecycleToolRouter } from "./lifecycle.ts";
import { MCP_TOOL_DEFINITIONS } from "./tools.ts";
import type {
  JsonRpcId,
  JsonRpcRequest,
  JsonRpcResponse,
  McpServerOptions,
  McpStdioServer,
  McpToolCallResult,
} from "./types.ts";

export const MCP_MODERN_PROTOCOL_VERSION = "2026-07-28" as const;
export const MCP_LEGACY_PROTOCOL_VERSIONS = Object.freeze([
  "2025-11-25",
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
  "2024-10-07",
] as const);

/** All revisions this testable JSON-RPC facade understands, by era. */
export const MCP_PROTOCOL_VERSIONS = Object.freeze([
  MCP_MODERN_PROTOCOL_VERSION,
  ...MCP_LEGACY_PROTOCOL_VERSIONS,
] as const);

export const MCP_SUPPORTED_MODERN_PROTOCOL_VERSIONS = Object.freeze([
  MCP_MODERN_PROTOCOL_VERSION,
] as const);

export const MCP_DEFAULT_PROTOCOL_VERSION = "2025-03-26" as const;
export const MCP_SERVER_NAME = "agent-feed-mcp" as const;
export const MCP_SERVER_VERSION = "0.1.1" as const;

const PROTOCOL_VERSION_META_KEY = "io.modelcontextprotocol/protocolVersion" as const;
const CLIENT_INFO_META_KEY = "io.modelcontextprotocol/clientInfo" as const;
const CLIENT_CAPABILITIES_META_KEY = "io.modelcontextprotocol/clientCapabilities" as const;
const SERVER_INFO_META_KEY = "io.modelcontextprotocol/serverInfo" as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function validId(value: unknown): value is JsonRpcId {
  return typeof value === "string"
    || (typeof value === "number" && Number.isSafeInteger(value));
}

function requestId(value: unknown): JsonRpcId | null {
  if (!isRecord(value) || !Object.hasOwn(value, "id")) return null;
  return validId(value.id) ? value.id : null;
}

function requestFrom(value: unknown): { request: JsonRpcRequest | null; isNotification: boolean; id: JsonRpcId | null } {
  const id = requestId(value);
  if (!isRecord(value)
    || value.jsonrpc !== "2.0"
    || typeof value.method !== "string"
    || value.method.length === 0) {
    throw invalidRequest();
  }
  if (Object.hasOwn(value, "id") && !validId(value.id)) throw invalidRequest();
  if (Object.hasOwn(value, "params") && !isRecord(value.params)) throw invalidRequest();
  if (!Object.hasOwn(value, "id")) return { request: null, isNotification: true, id: null };
  return {
    request: {
      jsonrpc: "2.0",
      id: value.id as JsonRpcId,
      method: value.method,
      ...(value.params === undefined ? {} : { params: value.params as Record<string, unknown> }),
    },
    isNotification: false,
    id,
  };
}

function negotiateLegacyProtocolVersion(clientVersion: unknown): string {
  if (typeof clientVersion === "string" && MCP_LEGACY_PROTOCOL_VERSIONS.includes(clientVersion as typeof MCP_LEGACY_PROTOCOL_VERSIONS[number])) {
    return clientVersion;
  }
  return MCP_DEFAULT_PROTOCOL_VERSION;
}

function toolResult(result: McpToolCallResult): Record<string, unknown> {
  return {
    content: result.content,
    ...(result.isError === undefined ? {} : { isError: result.isError }),
    ...(result.structuredContent === undefined ? {} : { structuredContent: result.structuredContent }),
  };
}

type ProtocolEra = "legacy" | "modern";

function modernEnvelopeClaim(params: Record<string, unknown> | undefined): boolean {
  if (!isRecord(params) || !isRecord(params._meta)) return false;
  return Object.hasOwn(params._meta, PROTOCOL_VERSION_META_KEY);
}

function validateModernEnvelope(params: Record<string, unknown> | undefined): string {
  if (!isRecord(params) || !isRecord(params._meta)) {
    throw invalidParams("Invalid _meta envelope", { error: "modern_envelope_required" });
  }
  const meta = params._meta;
  const protocolVersion = meta[PROTOCOL_VERSION_META_KEY];
  if (typeof protocolVersion !== "string") {
    throw invalidParams("Invalid _meta envelope", { error: "protocol_version_required" });
  }
  if (!MCP_SUPPORTED_MODERN_PROTOCOL_VERSIONS.includes(protocolVersion as typeof MCP_MODERN_PROTOCOL_VERSION)) {
    throw unsupportedProtocolVersion(protocolVersion, MCP_SUPPORTED_MODERN_PROTOCOL_VERSIONS);
  }
  const clientCapabilities = meta[CLIENT_CAPABILITIES_META_KEY];
  if (!isRecord(clientCapabilities)) {
    throw invalidParams("Invalid _meta envelope", { error: "client_capabilities_required" });
  }
  const clientInfo = meta[CLIENT_INFO_META_KEY];
  if (clientInfo !== undefined
    && (!isRecord(clientInfo)
      || typeof clientInfo.name !== "string"
      || typeof clientInfo.version !== "string")) {
    throw invalidParams("Invalid _meta envelope", { error: "client_info_invalid" });
  }
  return protocolVersion;
}

function modernResult(result: Record<string, unknown>, serverName: string, serverVersion: string): Record<string, unknown> {
  return {
    resultType: "complete",
    ...result,
    _meta: {
      [SERVER_INFO_META_KEY]: { name: serverName, version: serverVersion },
    },
  };
}

/**
 * @internal
 *
 * JSON-RPC/MCP protocol adapter over newline-delimited stdin/stdout. The
 * adapter is retained for deterministic conformance and legacy unit tests.
 * Production stdio composition uses the official SDK in sdk.ts. All
 * lifecycle behavior is delegated to `LifecycleToolRouter` and ProducerService.
 */
export class AgentFeedMcpServer implements McpStdioServer {
  readonly router: LifecycleToolRouter;
  readonly server_name: string;
  readonly server_version: string;
  #initialized = false;
  #era: ProtocolEra | undefined;
  #negotiatedProtocolVersion: string = MCP_DEFAULT_PROTOCOL_VERSION;

  constructor(options: McpServerOptions) {
    this.router = new LifecycleToolRouter(options);
    this.server_name = options.server_name ?? MCP_SERVER_NAME;
    this.server_version = options.server_version ?? MCP_SERVER_VERSION;
    if (typeof this.server_name !== "string" || this.server_name.length === 0
      || typeof this.server_version !== "string" || this.server_version.length === 0) {
      throw new Error("invalid_server_identity");
    }
  }

  async handleMessage(message: unknown): Promise<JsonRpcResponse | null> {
    let parsed: { request: JsonRpcRequest | null; isNotification: boolean; id: JsonRpcId | null };
    try {
      parsed = requestFrom(message);
    } catch (error) {
      const protocolError = error instanceof McpProtocolError ? error : invalidRequest();
      return jsonRpcError(requestId(message), protocolError);
    }
    if (parsed.isNotification) {
      await this.#handleNotification(message as Record<string, unknown>);
      return null;
    }
    const request = parsed.request!;
    try {
      const result = await this.#dispatch(request);
      return { jsonrpc: "2.0", id: request.id, result };
    } catch (error) {
      const protocolError = error instanceof McpProtocolError ? error : internalError();
      return jsonRpcError(request.id, protocolError);
    }
  }

  /** Naming alias for transports/tests that use request terminology. */
  async handleRequest(message: unknown): Promise<JsonRpcResponse | null> {
    return this.handleMessage(message);
  }

  async start(input: NodeJS.ReadableStream = process.stdin, output: NodeJS.WritableStream = process.stdout): Promise<void> {
    const lines = createInterface({ input, crlfDelay: Infinity });
    for await (const line of lines) {
      if (line.trim().length === 0) continue;
      let message: unknown;
      try {
        message = JSON.parse(line) as unknown;
      } catch {
        const response = jsonRpcError(null, parseError());
        output.write(`${JSON.stringify(response)}\n`);
        continue;
      }
      const response = await this.handleMessage(message);
      if (response !== null) output.write(`${JSON.stringify(response)}\n`);
    }
  }

  async serve(input: NodeJS.ReadableStream = process.stdin, output: NodeJS.WritableStream = process.stdout): Promise<void> {
    return this.start(input, output);
  }

  async #handleNotification(message: Record<string, unknown>): Promise<void> {
    if (message.method === "notifications/initialized" || message.method === "notifications/cancelled") return;
    // Unknown notifications are intentionally ignored, as required by JSON-RPC.
  }

  async #dispatch(request: JsonRpcRequest): Promise<Record<string, unknown>> {
    if (this.#era === undefined) {
      // A valid reserved protocol-version claim is the modern opening. A
      // claim-less request remains a legacy opening so old clients can still
      // begin with initialize (or receive the standard not-initialized error).
      if (modernEnvelopeClaim(request.params)) {
        validateModernEnvelope(request.params);
        this.#era = "modern";
      } else {
        this.#era = "legacy";
      }
    }

    if (this.#era === "modern") {
      validateModernEnvelope(request.params);
      return this.#dispatchModern(request);
    }

    if (modernEnvelopeClaim(request.params)) {
      // A legacy connection is pinned by its first message. Never silently
      // switch eras or pass modern envelope data into legacy handlers.
      throw unsupportedProtocolVersion(
        request.params?._meta && isRecord(request.params._meta)
          ? request.params._meta[PROTOCOL_VERSION_META_KEY]
          : undefined,
        MCP_LEGACY_PROTOCOL_VERSIONS,
      );
    }
    if (request.method === "initialize") return this.#initialize(request.params);
    if (!this.#initialized) throw serverNotInitialized();
    if (request.method === "ping") return {};
    if (request.method === "tools/list") {
      if (request.params !== undefined && Object.keys(request.params).some((key) => key !== "cursor" && key !== "_meta")) {
        throw invalidParams();
      }
      return { tools: MCP_TOOL_DEFINITIONS.map((descriptor) => structuredClone(descriptor)) };
    }
    if (request.method === "tools/call") return this.#callTool(request.params);
    throw methodNotFound();
  }

  async #dispatchModern(request: JsonRpcRequest): Promise<Record<string, unknown>> {
    if (request.method === "server/discover") {
      if (request.params !== undefined && Object.keys(request.params).some((key) => key !== "_meta")) {
        throw invalidParams();
      }
      return modernResult({
        ttlMs: 0,
        cacheScope: "private",
        supportedVersions: [...MCP_SUPPORTED_MODERN_PROTOCOL_VERSIONS],
        capabilities: { tools: { listChanged: false } },
        instructions: "Agent Feed producer lifecycle tools. All records are validated and scoped by the producer application service.",
      }, this.server_name, this.server_version);
    }
    if (request.method === "initialize" || request.method === "ping") throw methodNotFound();
    if (request.method === "tools/list") {
      if (request.params !== undefined && Object.keys(request.params).some((key) => key !== "cursor" && key !== "_meta")) {
        throw invalidParams();
      }
      return modernResult({
        ttlMs: 0,
        cacheScope: "private",
        tools: MCP_TOOL_DEFINITIONS.map((descriptor) => structuredClone(descriptor)),
      }, this.server_name, this.server_version);
    }
    if (request.method === "tools/call") {
      return modernResult(await this.#callTool(request.params), this.server_name, this.server_version);
    }
    throw methodNotFound();
  }

  #initialize(params: Record<string, unknown> | undefined): Record<string, unknown> {
    if (this.#initialized) throw invalidRequest("Server already initialized");
    if (!isRecord(params)
      || typeof params.protocolVersion !== "string"
      || !isRecord(params.capabilities)
      || !isRecord(params.clientInfo)
      || typeof params.clientInfo.name !== "string"
      || typeof params.clientInfo.version !== "string") {
      throw invalidParams();
    }
    if (params.protocolVersion === MCP_MODERN_PROTOCOL_VERSION) {
      throw unsupportedProtocolVersion(params.protocolVersion, MCP_LEGACY_PROTOCOL_VERSIONS);
    }
    this.#negotiatedProtocolVersion = negotiateLegacyProtocolVersion(params.protocolVersion);
    this.#initialized = true;
    return {
      protocolVersion: this.#negotiatedProtocolVersion,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: this.server_name, version: this.server_version },
      instructions: "Agent Feed producer lifecycle tools. All records are validated and scoped by the producer application service.",
    };
  }

  async #callTool(params: Record<string, unknown> | undefined): Promise<Record<string, unknown>> {
    if (!isRecord(params) || typeof params.name !== "string") throw invalidParams();
    const args = params.arguments === undefined ? {} : params.arguments;
    const result = await this.router.call(params.name, args);
    return toolResult(result);
  }
}

export function createAgentFeedMcpServer(options: McpServerOptions): AgentFeedMcpServer {
  return new AgentFeedMcpServer(options);
}

export function createMcpServer(options: McpServerOptions): AgentFeedMcpServer {
  return createAgentFeedMcpServer(options);
}

/** Familiar short name for consumers that do not need the Agent Feed prefix. */
export const McpServer = AgentFeedMcpServer;

export function createMcpStdioServer(options: McpServerOptions): AgentFeedMcpServer {
  return createAgentFeedMcpServer(options);
}

export async function runMcpStdioServer(
  options: McpServerOptions,
  input: NodeJS.ReadableStream = process.stdin,
  output: NodeJS.WritableStream = process.stdout,
): Promise<void> {
  await createAgentFeedMcpServer(options).start(input, output);
}
