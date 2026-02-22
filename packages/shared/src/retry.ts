import type { RetryPolicy } from './types.js';

export interface RetryDecision {
  retryable: boolean;
  reason: string;
}

export function isTransientFailure(params: {
  timedOut: boolean;
  networkError: boolean;
  statusCode?: number;
  retryOn409?: boolean;
}): RetryDecision {
  if (params.timedOut) {
    return { retryable: true, reason: 'timeout' };
  }

  if (params.networkError) {
    return { retryable: true, reason: 'network_error' };
  }

  if (typeof params.statusCode === 'number') {
    if (params.statusCode >= 500) {
      return { retryable: true, reason: 'server_error' };
    }

    if (params.statusCode === 409 && params.retryOn409) {
      return { retryable: true, reason: 'conflict_retry_enabled' };
    }

    return { retryable: false, reason: 'client_error' };
  }

  return { retryable: false, reason: 'unknown' };
}

export function computeBackoffMs(policy: RetryPolicy, attemptNo: number, random = Math.random()): number {
  const exponential = policy.initialDelayMs * Math.pow(policy.multiplier, Math.max(0, attemptNo - 1));
  const bounded = Math.min(policy.maxDelayMs, exponential);

  if (policy.jitter <= 0) {
    return Math.floor(bounded);
  }

  const jitterFactor = 1 - policy.jitter + random * (2 * policy.jitter);
  return Math.max(0, Math.floor(bounded * jitterFactor));
}
