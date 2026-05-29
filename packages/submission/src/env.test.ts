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

  it('rejects a missing scan signing key in production', () => {
    expect(() =>
      parseEnv({
        NODE_ENV: 'production',
        AUTH_MODE: 'entra',
        SCANNER_IMAGE:
          'registry.example/asr-scanner@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      }),
    ).toThrow(/SCAN_SIGNING_KEY is required in production/);
  });

  it('rejects tag-pinned scanner images in production', () => {
    expect(() =>
      parseEnv({
        NODE_ENV: 'production',
        AUTH_MODE: 'entra',
        SCANNER_IMAGE: 'registry.example/asr-scanner:latest',
        SCAN_SIGNING_KEY: 'test-signing-key',
      }),
    ).toThrow(/SCANNER_IMAGE must be pinned by sha256 digest/);
  });

  it('warns when scan signing is explicitly disabled outside production', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    expect(
      parseEnv({
        NODE_ENV: 'development',
        AUTH_MODE: 'mock',
        SCAN_SIGNING_DISABLED: 'true',
      }),
    ).toMatchObject({
      SCAN_SIGNING_DISABLED: 'true',
    });

    expect(warn).toHaveBeenCalledWith(
      'WARNING: scanner report signature verification is disabled',
    );
    warn.mockRestore();
  });

  it('defaults the marketplace repo when the marketplace owner is set', () => {
    expect(
      parseEnv({
        NODE_ENV: 'development',
        AUTH_MODE: 'mock',
        FORGEJO_MARKETPLACE_OWNER: 'asr-marketplace',
      }),
    ).toMatchObject({
      FORGEJO_MARKETPLACE_OWNER: 'asr-marketplace',
      FORGEJO_MARKETPLACE_REPO: 'skill-marketplace',
    });
  });
});
