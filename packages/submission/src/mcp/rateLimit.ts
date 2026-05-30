import { MCP_ERROR, mcpError, type McpErrorObject } from './errors.js';

export type ToolClass = 'mutating' | 'read';

const LIMITS: Record<ToolClass, number> = {
  mutating: 60,
  read: 600,
};

const WINDOW_MS = 60_000;
export const MAX_RATE_LIMIT_BUCKETS = 4_096;

export function toolClass(tool: string): ToolClass {
  return tool === 'review_decision' ? 'mutating' : 'read';
}

export type RateLimitResult = { ok: true } | { ok: false; retryAfterSeconds: number };

export interface RateLimiter {
  check(principalSub: string, tool: string): RateLimitResult;
}

interface BucketState {
  windowStart: number;
  count: number;
}

function sweepStaleBuckets(buckets: Map<string, BucketState>, now: number): void {
  for (const [key, bucket] of buckets) {
    if (bucket.windowStart + WINDOW_MS <= now) {
      buckets.delete(key);
    }
  }
}

function deleteOldestBucket(buckets: Map<string, BucketState>): void {
  const oldestKey = buckets.keys().next().value as string | undefined;
  if (oldestKey !== undefined) {
    buckets.delete(oldestKey);
  }
}

export function createRateLimiter(
  now: () => number = () => Date.now(),
): RateLimiter & { bucketCount(): number } {
  const buckets = new Map<string, BucketState>();

  return {
    check(principalSub, tool) {
      const klass = toolClass(tool);
      const limit = LIMITS[klass];
      const t = now();
      sweepStaleBuckets(buckets, t);
      const windowStart = Math.floor(t / WINDOW_MS) * WINDOW_MS;
      const key = `${principalSub}|${klass}`;
      let bucket = buckets.get(key);
      if (!bucket || bucket.windowStart !== windowStart) {
        bucket = { windowStart, count: 0 };
        if (!buckets.has(key) && buckets.size >= MAX_RATE_LIMIT_BUCKETS) {
          deleteOldestBucket(buckets);
        }
        buckets.set(key, bucket);
      } else {
        buckets.delete(key);
        buckets.set(key, bucket);
      }
      if (bucket.count >= limit) {
        const retryAfterSeconds = Math.max(
          1,
          Math.ceil((windowStart + WINDOW_MS - t) / 1000),
        );
        return { ok: false, retryAfterSeconds };
      }
      bucket.count += 1;
      return { ok: true };
    },
    bucketCount() {
      return buckets.size;
    },
  };
}

export function rateLimitedError(retryAfterSeconds: number): McpErrorObject {
  return mcpError(MCP_ERROR.rate_limited, 'rate_limited', { retryAfterSeconds });
}
