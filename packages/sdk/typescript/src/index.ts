export {
  AgentFeedClient,
  type AgentFeedClientOptions,
  type AgentFeedRequestOptions,
} from "./client.ts";
export {
  AgentFeedAbortError,
  AgentFeedApiError,
  AgentFeedError,
  AgentFeedResponseError,
  AgentFeedTimeoutError,
  AgentFeedTransportError,
  isAgentFeedError,
  type AgentFeedErrorDiagnostic,
  type AgentFeedErrorKind,
  type AgentFeedErrorOptions,
} from "./errors.ts";
export {
  DEFAULT_RETRY_POLICY,
  defaultSleep,
  resolveRetryPolicy,
  retryDelayMilliseconds,
  type RetryPolicy,
  type RetryPolicyOverrides,
  type RetrySleepOptions,
} from "./retry.ts";
export {
  FetchTransport,
  HttpTransport,
  type AgentFeedHttpMethod,
  type AgentFeedTransport,
  type AgentFeedTransportRequest,
  type AgentFeedTransportResponse,
  type FetchTransportOptions,
} from "./transport.ts";
export {
  AgentFeedProducerClient,
  ProducerClient,
  createRunBundle,
  type ProducerClientOptions,
  type ProducerFindingsOptions,
  type SubmitLargeRunOptions,
  type SubmitLargeRunProgress,
  type SubmitLargeRunSummary,
} from "./producer.ts";
export {
  LARGE_RUN_DEFAULTS,
  planLargeRunBatches,
  type LargeRunBatchPlanOptions,
  type LargeRunUnit,
} from "./large-run.ts";
export {
  AgentFeedConsumerClient,
  ConsumerClient,
  type ConsumerClientOptions,
  type ConsumerRequestOptions,
} from "./consumer.ts";
export type * from "./types.ts";
export type * from "../generated/protocol.ts";

/** Wire protocol version implemented by this package. */
export const PROTOCOL_VERSION = "0.1" as const;
/** npm artifact version; intentionally distinct from protocol version. */
export const PACKAGE_VERSION = "0.1.1" as const;
