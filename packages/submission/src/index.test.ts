import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { app as App } from './index.js';

let app: typeof App;

beforeAll(async () => {
  vi.stubEnv('NODE_ENV', 'development');
  vi.stubEnv('AUTH_MODE', 'mock');

  ({ app } = await import('./index.js'));
});

describe('app', () => {
  it('returns health status', async () => {
    const res = await app.request('/healthz');

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ status: 'ok' });
  });
});
