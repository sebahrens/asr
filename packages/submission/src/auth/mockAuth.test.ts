import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { mockAuth } from './mockAuth.js';
import type { AuthVariables } from './types.js';

describe('mockAuth', () => {
  it('injects identity from MOCK_USER_* env vars', async () => {
    vi.stubEnv('MOCK_USER_SUB', 'u1');
    vi.stubEnv('MOCK_USER_ROLES', 'Submitter,Compliance');

    const app = new Hono<{ Variables: AuthVariables }>();
    app.use('*', mockAuth());
    app.get('/', (c) => c.json(c.get('identity')));

    const res = await app.request('/');

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      sub: 'u1',
      roles: ['Submitter', 'Compliance'],
    });

    vi.unstubAllEnvs();
  });
});
