import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { isExemptPath, requireRole } from './requireRole.js';
import type { AuthVariables } from './types.js';

describe('requireRole', () => {
  it('allows requests with a matching role', async () => {
    const app = new Hono<{ Variables: AuthVariables }>();
    app.use('*', async (c, next) => {
      c.set('identity', { sub: 'u1', roles: ['Compliance'] });
      await next();
    });
    app.get('/', requireRole('Compliance'), (c) => c.json({ ok: true }));

    const res = await app.request('/');

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true });
  });

  it('returns 403 when the identity lacks the required role', async () => {
    const app = new Hono<{ Variables: AuthVariables }>();
    app.use('*', async (c, next) => {
      c.set('identity', { sub: 'u1', roles: ['Submitter'] });
      await next();
    });
    app.get('/', requireRole('Compliance'), (c) => c.json({ ok: true }));

    const res = await app.request('/');

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual({
      error: 'insufficient_permissions',
      required: 'Compliance',
    });
  });

  it('returns 401 when no identity is present', async () => {
    const app = new Hono<{ Variables: AuthVariables }>();
    app.get('/', requireRole('Compliance'), (c) => c.json({ ok: true }));

    const res = await app.request('/');

    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ error: 'authentication_required' });
  });
});

describe('isExemptPath', () => {
  it('matches unauthenticated paths from the role matrix', () => {
    expect(isExemptPath('/health')).toBe(true);
    expect(isExemptPath('/api/health')).toBe(true);
    expect(isExemptPath('/version')).toBe(true);
    expect(isExemptPath('/webhooks/forgejo')).toBe(true);
    expect(isExemptPath('/submissions')).toBe(false);
  });
});
