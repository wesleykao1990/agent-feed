// The executable/public composition is the official SDK path below. The
// hand-written era adapter remains in src/server.ts only for deterministic
// conformance tests and legacy embedders; it is intentionally not re-exported
// from the package root.
export { LifecycleToolRouter, createLifecycleToolRouter } from "./lifecycle.ts";
export {
  MCP_TOOL_DEFINITIONS,
  MCP_TOOL_NAMES,
  toolDescriptor,
} from "./tools.ts";
export {
  authorizationFromEnvironment,
  credentialsFromEnvironment,
  createOfficialMcpServerFromEnvironment,
} from "./composition.ts";
export {
  JSON_RPC_ERROR_CODES,
  McpProtocolError,
  internalError,
  invalidParams,
  invalidRequest,
  jsonRpcError,
  methodNotFound,
  parseError,
  safeToolError,
  serverNotInitialized,
  unsupportedProtocolVersion,
} from "./errors.ts";
export {
  createOfficialMcpServer,
  serveAgentFeedMcpStdio,
} from "./sdk.ts";
export type * from "./types.ts";
