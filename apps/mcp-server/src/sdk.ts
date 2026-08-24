import {
  ProtocolError,
  Server,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/server";
import {
  serveStdio,
  type ServeStdioOptions,
  type StdioServerHandle,
} from "@modelcontextprotocol/server/stdio";
import {
  McpProtocolError,
} from "./errors.ts";
import { LifecycleToolRouter } from "./lifecycle.ts";
import {
  MCP_REMOTE_TOOL_DEFINITIONS,
  MCP_TOOL_DEFINITIONS,
} from "./tools.ts";
import type { McpServerOptions, McpToolDescriptor } from "./types.ts";

const INSTRUCTIONS = "Agent Feed producer lifecycle tools. All records are validated and scoped by the producer application service.";

function sdkProtocolError(error: unknown): ProtocolError {
  if (error instanceof McpProtocolError) {
    return new ProtocolError(error.code, error.message, error.data);
  }
  return new ProtocolError(-32603, "Internal error");
}

function toolResult(result: Awaited<ReturnType<LifecycleToolRouter["call"]>>): CallToolResult {
  return {
    content: result.content.map((item) => ({ type: "text" as const, text: item.text })),
    ...(result.isError === undefined ? {} : { isError: result.isError }),
    ...(result.structuredContent === undefined ? {} : { structuredContent: result.structuredContent }),
  };
}

function sdkToolDescriptor(descriptor: McpToolDescriptor): Tool {
  const annotations = descriptor.annotations;
  return {
    name: descriptor.name,
    description: descriptor.description,
    inputSchema: descriptor.inputSchema as Tool["inputSchema"],
    ...(annotations === undefined ? {} : {
      annotations: {
        readOnlyHint: annotations.readOnlyHint === true,
        destructiveHint: annotations.destructiveHint === true,
        idempotentHint: annotations.idempotentHint === true,
        openWorldHint: annotations.openWorldHint === true,
      },
    }),
  };
}

function createServer(options: McpServerOptions, definitions: readonly McpToolDescriptor[]): Server {
  const router = new LifecycleToolRouter(options);
  const server = new Server(
    {
      name: options.server_name ?? "agent-feed-mcp",
      version: options.server_version ?? "0.1.1",
    },
    {
      capabilities: { tools: { listChanged: false } },
      instructions: INSTRUCTIONS,
    },
  );

  server.setRequestHandler("tools/list", () => ({
    tools: definitions.map((descriptor) => sdkToolDescriptor(structuredClone(descriptor))),
  }));
  server.setRequestHandler("tools/call", async (request) => {
    try {
      const result = await router.call(request.params.name, request.params.arguments ?? {});
      return toolResult(result);
    } catch (error) {
      throw sdkProtocolError(error);
    }
  });
  return server;
}

/** Keep the historical three primitive lifecycle tools for stdio/conformance. */
export function createOfficialMcpServer(options: McpServerOptions): Server {
  return createServer(options, MCP_TOOL_DEFINITIONS);
}

/** Remote HTTP composition adds the interruption-safe composite tool. */
export function createOfficialRemoteMcpServer(options: McpServerOptions): Server {
  return createServer(options, MCP_REMOTE_TOOL_DEFINITIONS);
}

/** Official dual-era stdio composition used by tests and embedding hosts. */
export function serveAgentFeedMcpStdio(
  options: McpServerOptions,
  serveOptions?: ServeStdioOptions,
): StdioServerHandle {
  return serveStdio(() => createOfficialMcpServer(options), serveOptions);
}
