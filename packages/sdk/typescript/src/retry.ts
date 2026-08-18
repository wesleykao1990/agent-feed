import { AgentFeedAbortError } from "./errors.ts";

export interface RetryPolicy {
  /** Total attempts, including the first request. `1` disables retries. */
  readonly max_attempts: number;
  readonly base_delay_ms: number;
  readonly max_delay_ms: number;
  /** Optional deterministic or bounded jitter in milliseconds. */
  readonly jitter_ms: number;
}

export const DEFAULT_RETRY_POLICY: Readonly<RetryPolicy> = Object.freeze({
  max_attempts: 3,
  base_delay_ms: 100,
  max_delay_ms: 2_000,
  jitter_ms: 0,
});

export interface RetryPolicyOverrides {
  readonly max_attempts?: number;
  readonly maxAttempts?: number;
  readonly base_delay_ms?: number;
  readonly baseDelayMs?: number;
  readonly max_delay_ms?: number;
  readonly maxDelayMs?: number;
  readonly jitter_ms?: number;
  readonly jitterMs?: number;
}

export interface RetrySleepOptions {
  readonly sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  readonly random?: () => number;
}

export function resolveRetryPolicy(overrides: RetryPolicyOverrides = {}): RetryPolicy {
  const policy = {
    max_attempts: overrides.max_attempts ?? overrides.maxAttempts ?? DEFAULT_RETRY_POLICY.max_attempts,
    base_delay_ms: overrides.base_delay_ms ?? overrides.baseDelayMs ?? DEFAULT_RETRY_POLICY.base_delay_ms,
    max_delay_ms: overrides.max_delay_ms ?? overrides.maxDelayMs ?? DEFAULT_RETRY_POLICY.max_delay_ms,
    jitter_ms: overrides.jitter_ms ?? overrides.jitterMs ?? DEFAULT_RETRY_POLICY.jitter_ms,
  };
  if (!Number.isSafeInteger(policy.max_attempts) || policy.max_attempts < 1) throw new Error("invalid_retry_max_attempts");
  if (!Number.isSafeInteger(policy.base_delay_ms) || policy.base_delay_ms < 0) throw new Error("invalid_retry_base_delay");
  if (!Number.isSafeInteger(policy.max_delay_ms) || policy.max_delay_ms < 0 || policy.max_delay_ms < policy.base_delay_ms) throw new Error("invalid_retry_max_delay");
  if (!Number.isSafeInteger(policy.jitter_ms) || policy.jitter_ms < 0) throw new Error("invalid_retry_jitter");
  return policy;
}

export function retryDelayMilliseconds(
  policy: RetryPolicy,
  retryNumber: number,
  retryAfterSeconds: number | null,
  random: () => number = Math.random,
): number {
  const exponential = Math.min(policy.max_delay_ms, policy.base_delay_ms * (2 ** Math.max(0, retryNumber - 1)));
  const serverDelay = retryAfterSeconds === null ? 0 : Math.min(policy.max_delay_ms, Math.max(0, Math.ceil(retryAfterSeconds * 1000)));
  const jitter = policy.jitter_ms === 0 ? 0 : Math.floor(Math.max(0, Math.min(1, random())) * policy.jitter_ms);
  return Math.min(policy.max_delay_ms, Math.max(exponential, serverDelay) + jitter);
}

export function defaultSleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new AgentFeedAbortError({ operation: "retry_sleep" }));
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    const onAbort = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(new AgentFeedAbortError({ operation: "retry_sleep" }));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
