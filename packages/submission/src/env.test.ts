import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { parseEnv as ParseEnv } from './env.js';

let parseEnv: typeof ParseEnv;

const productionEnv = {
  NODE_ENV: 'production',
  AUTH_MODE: 'entra',
  AZURE_TENANT_ID: 'tenant-id',
  AZURE_CLIENT_ID: 'client-id',
  FORGEJO_URL: 'https://forgejo.example.test',
  FORGEJO_UPLOAD_TOKEN: 'upload-token',
  FORGEJO_MERGE_TOKEN: 'merge-token',
  FORGEJO_OWNER: 'asr',
  FORGEJO_REPO: 'skills-registry',
  FORGEJO_MARKETPLACE_OWNER: 'asr',
  FORGEJO_MARKETPLACE_REPO: 'skill-marketplace',
  DATABASE_PATH: '/tmp/asr.db',
  PUBLIC_BASE_URL: 'https://api.example.test',
  AUDIT_HMAC_KEY_ID: 'primary',
  AUDIT_HMAC_KEY_BYTES: Buffer.alloc(32, 0x11).toString('base64'),
  SCANNER_IMAGE:
    'registry.example/asr-scanner@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  SCAN_SIGNING_KEY: 'test-signing-key',
} as const;

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
        MOCK_USER_SUB: 'dev-user',
        MOCK_USER_ROLES: 'Submitter',
      }),
    ).toThrow(/forbidden in production/);
  });

  it('defaults development mock auth to port 3001', () => {
    expect(
      parseEnv({
        NODE_ENV: 'development',
        AUTH_MODE: 'mock',
        MOCK_USER_SUB: 'dev-user',
        MOCK_USER_ROLES: 'Submitter,Compliance',
      }),
    ).toMatchObject({
      PORT: 3001,
      AUTH_MODE: 'mock',
    });
  });

  it('rejects a missing scan signing key in production', () => {
    expect(() =>
      parseEnv({
        ...productionEnv,
        SCAN_SIGNING_KEY: '',
      }),
    ).toThrow(/SCAN_SIGNING_KEY is required in production/);
  });

  it('rejects missing production Forgejo and audit env at boot', () => {
    expect(() =>
      parseEnv({
        ...productionEnv,
        FORGEJO_OWNER: '',
        FORGEJO_REPO: '',
        AUDIT_HMAC_KEY_ID: '',
      }),
    ).toThrow(/FORGEJO_OWNER is required in production/);
  });

  it('rejects tag-pinned scanner images in production', () => {
    expect(() =>
      parseEnv({
        ...productionEnv,
        SCANNER_IMAGE: 'registry.example/asr-scanner:latest',
      }),
    ).toThrow(/SCANNER_IMAGE must be pinned by sha256 digest/);
  });

  it('warns when scan signing is explicitly disabled outside production', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    expect(
      parseEnv({
        NODE_ENV: 'development',
        AUTH_MODE: 'mock',
        MOCK_USER_SUB: 'dev-user',
        MOCK_USER_ROLES: 'Submitter',
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
        MOCK_USER_SUB: 'dev-user',
        MOCK_USER_ROLES: 'Submitter',
        FORGEJO_MARKETPLACE_OWNER: 'asr-marketplace',
      }),
    ).toMatchObject({
      FORGEJO_MARKETPLACE_OWNER: 'asr-marketplace',
      FORGEJO_MARKETPLACE_REPO: 'skill-marketplace',
    });
  });
});
