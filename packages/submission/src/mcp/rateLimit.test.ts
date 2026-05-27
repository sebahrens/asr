import { describe, expect, it } from 'vitest';
import { MCP_ERROR } from './errors.js';
import { createRateLimiter, rateLimitedError, toolClass } from './rateLimit.js';

describe('toolClass', () => {
  it('classifies review_decision as mutating', () => {
    expect(toolClass('review_decision')).toBe('mutating');
  });

  it('classifies every other tool as read', () => {
    expect(toolClass('registry_search')).toBe('read');
    expect(toolClass('registry_info')).toBe('read');
    expect(toolClass('registry_versions')).toBe('read');
    expect(toolClass('')).toBe('read');
  });
});

describe('createRateLimiter', () => {
  it('blocks the 61st review_decision call within one window for the same principal', () => {
    let now = 1_000_000;
    const limiter = createRateLimiter(() => now);

    for (let i = 0; i < 60; i++) {
      expect(limiter.check('p1', 'review_decision')).toEqual({ ok: true });
    }

    const result = limiter.check('p1', 'review_decision');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(typeof result.retryAfterSeconds).toBe('number');
      expect(result.retryAfterSeconds).toBeGreaterThanOrEqual(1);
      expect(result.retryAfterSeconds).toBeLessThanOrEqual(60);
    }
  });

  it('allows 600 read calls and blocks the 601st', () => {
    let now = 0;
    const limiter = createRateLimiter(() => now);

    for (let i = 0; i < 600; i++) {
      expect(limiter.check('p1', 'registry_search')).toEqual({ ok: true });
    }

    const result = limiter.check('p1', 'registry_search');
    expect(result.ok).toBe(false);
  });

  it('resets the counter once the clock advances past the window', () => {
    let now = 0;
    const limiter = createRateLimiter(() => now);

    for (let i = 0; i < 60; i++) {
      limiter.check('p1', 'review_decision');
    }
    expect(limiter.check('p1', 'review_decision').ok).toBe(false);

    now = 60_000;
    expect(limiter.check('p1', 'review_decision')).toEqual({ ok: true });
  });

  it('tracks mutating and read buckets independently per principal', () => {
    let now = 0;
    const limiter = createRateLimiter(() => now);

    for (let i = 0; i < 60; i++) {
      limiter.check('p1', 'review_decision');
    }
    expect(limiter.check('p1', 'review_decision').ok).toBe(false);
    expect(limiter.check('p1', 'registry_search')).toEqual({ ok: true });
  });

  it('isolates counts between different principals', () => {
    let now = 0;
    const limiter = createRateLimiter(() => now);

    for (let i = 0; i < 60; i++) {
      limiter.check('p1', 'review_decision');
    }
    expect(limiter.check('p1', 'review_decision').ok).toBe(false);
    expect(limiter.check('p2', 'review_decision')).toEqual({ ok: true });
  });

  it('reports whole seconds remaining until the current window rolls over', () => {
    let now = 30_500;
    const limiter = createRateLimiter(() => now);

    for (let i = 0; i < 60; i++) {
      limiter.check('p1', 'review_decision');
    }
    const result = limiter.check('p1', 'review_decision');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.retryAfterSeconds).toBe(30);
    }
  });
});

describe('rateLimitedError', () => {
  it('returns the spec-correct -32005 envelope with retryAfterSeconds', () => {
    expect(rateLimitedError(42)).toEqual({
      code: MCP_ERROR.rate_limited,
      message: 'rate_limited',
      data: { retryAfterSeconds: 42 },
    });
  });
});
