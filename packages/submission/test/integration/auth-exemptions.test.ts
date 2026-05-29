import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { authMiddleware } from '../../src/auth/middleware.js';
import type { AuthVariables } from '../../src/auth/types.js';

describe('auth exemption routing', () => {
  it('rejects a webhook route that does not install its own HMAC verifier', async () => {
    const app = new Hono<{ Variables: AuthVariables }>();
    app.use('*', authMiddleware({ authMode: 'entra' }));
    app.post('/webhooks/foo', (c) => c.json({ ok: true }));

    const res = await app.request('/webhooks/foo', { method: 'POST' });

    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ error: 'authentication_required' });
  });
});
