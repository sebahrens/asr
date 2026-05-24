import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { assertAuthModeAllowed } from './entra.js';

describe('assertAuthModeAllowed', () => {
  it('rejects mock auth in production', () => {
    expect(() => assertAuthModeAllowed({ NODE_ENV: 'production', AUTH_MODE: 'mock' })).toThrow(
      /forbidden in production/,
    );
  });

  it('allows mock auth outside production', () => {
    expect(() => assertAuthModeAllowed({ NODE_ENV: 'development', AUTH_MODE: 'mock' })).not.toThrow();
  });

  it('allows Entra auth in production', () => {
    expect(() => assertAuthModeAllowed({ NODE_ENV: 'production', AUTH_MODE: 'entra' })).not.toThrow();
  });

  it('exits non-zero when the entrypoint boots production with mock auth', () => {
    const result = spawnSync('pnpm', ['exec', 'tsx', 'src/index.ts'], {
      cwd: fileURLToPath(new URL('../..', import.meta.url)),
      encoding: 'utf8',
      env: {
        ...process.env,
        NODE_ENV: 'production',
        AUTH_MODE: 'mock',
      },
    });

    expect(result.status).not.toBe(0);
    expect(`${result.stderr}${result.stdout}`).toContain('FATAL: AUTH_MODE=mock is forbidden in production');
  });
});
