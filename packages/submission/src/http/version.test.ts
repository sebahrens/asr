import { describe, expect, it } from 'vitest';
import { createVersionRoutes } from './version.js';

describe('GET /version', () => {
  it('returns build and spec metadata without auth state', async () => {
    const app = createVersionRoutes({
      buildSha: 'abc123',
      specVersion: '2026-05-30',
      serviceVersion: '0.1.0-test',
    });

    const res = await app.request('/');

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      version: '0.1.0-test',
      buildSha: 'abc123',
      specVersion: '2026-05-30',
    });
  });
});
