import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { parseEnv as ParseEnv } from './env.js';

let parseEnv: typeof ParseEnv;

beforeAll(async () => {
  vi.stubEnv('NODE_ENV', 'development');
  vi.stubEnv('AUTH_MODE', 'mock');

  ({ parseEnv } = await import('./env.js'));
});

describe('parseEnv', () => {
  it('rejects mock auth in production', () => {
    expect(() =>
      parseEnv({
        NODE_ENV: 'production',
        AUTH_MODE: 'mock',
      }),
    ).toThrow(/forbidden in production/);
  });

  it('defaults development mock auth to port 3001', () => {
    expect(
      parseEnv({
        NODE_ENV: 'development',
        AUTH_MODE: 'mock',
      }),
    ).toMatchObject({
      PORT: 3001,
      AUTH_MODE: 'mock',
    });
  });
});
