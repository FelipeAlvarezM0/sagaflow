import { describe, expect, it } from 'vitest';
import { computeBackoffMs, isTransientFailure } from '@sagaflow/shared';

describe('retry utilities', () => {
  it('classifies transient failures correctly', () => {
    expect(isTransientFailure({ timedOut: true, networkError: false }).retryable).toBe(true);
    expect(isTransientFailure({ timedOut: false, networkError: true }).retryable).toBe(true);
    expect(isTransientFailure({ timedOut: false, networkError: false, statusCode: 503 }).retryable).toBe(true);
    expect(
      isTransientFailure({ timedOut: false, networkError: false, statusCode: 409, retryOn409: true }).retryable
    ).toBe(true);
    expect(isTransientFailure({ timedOut: false, networkError: false, statusCode: 400 }).retryable).toBe(false);
  });

  it('computes bounded backoff with jitter', () => {
    const delay = computeBackoffMs(
      {
        maxAttempts: 5,
        initialDelayMs: 100,
        maxDelayMs: 1000,
        multiplier: 2,
        jitter: 0.1
      },
      3,
      0.5
    );

    expect(delay).toBeGreaterThanOrEqual(360);
    expect(delay).toBeLessThanOrEqual(440);
  });
});
