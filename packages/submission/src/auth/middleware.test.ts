import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { authMiddleware } from './middleware.js';
import { requireRole } from './requireRole.js';
import type { AuthVariables } from './types.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('authMiddleware', () => {
  it('allows mock Compliance users through Compliance-only routes', async () => {
    vi.stubEnv('MOCK_USER_SUB', 'u1');
    vi.stubEnv('MOCK_USER_ROLES', 'Compliance');

    const app = new Hono<{ Variables: AuthVariables }>();
    app.use('*', authMiddleware({ authMode: 'mock' }));
    app.get('/review', requireRole('Compliance'), (c) => c.json({ ok: true }));

    const res = await app.request('/review');

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true });
  });

  it('rejects mock Submitter users from Compliance-only routes', async () => {
    vi.stubEnv('MOCK_USER_SUB', 'u1');
    vi.stubEnv('MOCK_USER_ROLES', 'Submitter');

    const app = new Hono<{ Variables: AuthVariables }>();
    app.use('*', authMiddleware({ authMode: 'mock' }));
    app.get('/review', requireRole('Compliance'), (c) => c.json({ ok: true }));

    const res = await app.request('/review');

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual({
      error: 'insufficient_permissions',
      required: 'Compliance',
    });
  });

  it('skips auth for exempt paths', async () => {
    const app = new Hono<{ Variables: AuthVariables }>();
    app.use('*', authMiddleware({ authMode: 'entra' }));
    app.get('/api/health', (c) => c.json({ status: 'ok' }));

    const res = await app.request('/api/health');

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ status: 'ok' });
  });
});
