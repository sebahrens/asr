import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { apiError } from './errors.js';

describe('apiError', () => {
  it('returns the closed error envelope with the requested status', async () => {
    const app = new Hono();
    app.get('/', (c) => apiError(c, 400, 'invalid_zip'));

    const res = await app.request('/');

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: 'invalid_zip' });
  });

  it('includes optional error metadata', async () => {
    const app = new Hono();
    app.get('/', (c) =>
      apiError(c, 403, 'insufficient_permissions', {
        message: 'Compliance role required',
        required: 'Compliance',
      }),
    );

    const res = await app.request('/');

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual({
      error: 'insufficient_permissions',
      message: 'Compliance role required',
      required: 'Compliance',
    });
  });
});
