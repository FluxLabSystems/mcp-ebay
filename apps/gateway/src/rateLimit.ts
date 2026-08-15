/**
 * Token-bucket rate limiting — audit F-05. Per-key buckets refill
 * continuously; capacity equals the per-minute limit so short bursts up
 * to one minute's budget are allowed. A limit of 0 disables the limiter
 * (used by test harnesses that hammer the endpoint deliberately).
 */

interface Bucket {
  tokens: number;
  at: number;
}

const MAX_TRACKED_KEYS = 10_000;

export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();

  constructor(private readonly perMinute: number) {}

  get enabled(): boolean {
    return this.perMinute > 0;
  }

  /** Take one token for `key`; false means rate-limited. */
  tryTake(key: string, now: number = Date.now()): boolean {
    if (!this.enabled) return true;
    let bucket = this.buckets.get(key);
    if (bucket === undefined) {
      if (this.buckets.size >= MAX_TRACKED_KEYS) this.prune(now);
      bucket = { tokens: this.perMinute, at: now };
      this.buckets.set(key, bucket);
    }
    const refill = ((now - bucket.at) / 60_000) * this.perMinute;
    bucket.tokens = Math.min(this.perMinute, bucket.tokens + refill);
    bucket.at = now;
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return true;
    }
    return false;
  }

  /** Seconds until one token is available for `key` (for Retry-After). */
  retryAfterSeconds(key: string): number {
    const bucket = this.buckets.get(key);
    if (!this.enabled || bucket === undefined) return 1;
    const deficit = Math.max(0, 1 - bucket.tokens);
    return Math.max(1, Math.ceil((deficit / this.perMinute) * 60));
  }

  private prune(now: number): void {
    for (const [key, bucket] of this.buckets) {
      if (now - bucket.at > 120_000) this.buckets.delete(key);
      if (this.buckets.size < MAX_TRACKED_KEYS / 2) break;
    }
  }
}
