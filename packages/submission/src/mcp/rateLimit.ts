import { MCP_ERROR, mcpError, type McpErrorObject } from './errors.js';

export type ToolClass = 'mutating' | 'read';

const LIMITS: Record<ToolClass, number> = {
  mutating: 60,
  read: 600,
};

const WINDOW_MS = 60_000;

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

export function createRateLimiter(now: () => number = () => Date.now()): RateLimiter {
  const buckets = new Map<string, BucketState>();

  return {
    check(principalSub, tool) {
      const klass = toolClass(tool);
      const limit = LIMITS[klass];
      const t = now();
      const windowStart = Math.floor(t / WINDOW_MS) * WINDOW_MS;
      const key = `${principalSub}|${klass}`;
      let bucket = buckets.get(key);
      if (!bucket || bucket.windowStart !== windowStart) {
        bucket = { windowStart, count: 0 };
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
  };
}

export function rateLimitedError(retryAfterSeconds: number): McpErrorObject {
  return mcpError(MCP_ERROR.rate_limited, 'rate_limited', { retryAfterSeconds });
}
