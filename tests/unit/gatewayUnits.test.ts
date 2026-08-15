/**
 * Gateway unit coverage added by the Phase A stabilization batch:
 * timeout code mapping (audit F-02), the rate limiter (F-05), and the
 * artifact MIME allowlist (F-06).
 */
import { describe, expect, it } from 'vitest';
import { isAllowedArtifactMime } from '@browser-bridge/protocol';
import { RateLimiter, timeoutErrorCodeFor } from '@browser-bridge/gateway';

describe('timeout error code mapping (F-02)', () => {
  it('navigate deadlines are NAVIGATION_TIMEOUT; everything else CONDITION_TIMEOUT', () => {
    expect(timeoutErrorCodeFor('navigate')).toBe('NAVIGATION_TIMEOUT');
    for (const command of ['snapshot', 'screenshot', 'images', 'image_get', 'extract', 'session_open', 'handoff']) {
      expect(timeoutErrorCodeFor(command), command).toBe('CONDITION_TIMEOUT');
    }
  });
});

describe('token-bucket rate limiter (F-05)', () => {
  it('allows a burst up to capacity then refuses', () => {
    const limiter = new RateLimiter(3);
    const now = 1_000_000;
    expect(limiter.tryTake('k', now)).toBe(true);
    expect(limiter.tryTake('k', now)).toBe(true);
    expect(limiter.tryTake('k', now)).toBe(true);
    expect(limiter.tryTake('k', now)).toBe(false);
    expect(limiter.retryAfterSeconds('k', now)).toBeGreaterThanOrEqual(1);
  });

  it('refills continuously and keys are independent', () => {
    const limiter = new RateLimiter(60); // 1 token/s
    const now = 2_000_000;
    for (let i = 0; i < 60; i++) expect(limiter.tryTake('a', now)).toBe(true);
    expect(limiter.tryTake('a', now)).toBe(false);
    expect(limiter.tryTake('b', now)).toBe(true); // other key unaffected
    expect(limiter.tryTake('a', now + 1000)).toBe(true); // ~1 token refilled
  });

  it('a limit of 0 disables the bucket', () => {
    const limiter = new RateLimiter(0);
    for (let i = 0; i < 100; i++) expect(limiter.tryTake('k')).toBe(true);
    expect(limiter.enabled).toBe(false);
  });
});

describe('artifact MIME allowlist (F-06)', () => {
  it('permits passive raster images only', () => {
    for (const mime of ['image/png', 'image/jpeg', 'image/webp', 'image/avif', 'image/gif', 'IMAGE/PNG', 'image/png; charset=binary']) {
      expect(isAllowedArtifactMime(mime), mime).toBe(true);
    }
    for (const mime of ['image/svg+xml', 'text/html', 'application/xml', 'application/octet-stream', 'text/javascript', '']) {
      expect(isAllowedArtifactMime(mime), mime).toBe(false);
    }
  });
});
