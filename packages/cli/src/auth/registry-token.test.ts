import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FetchLike } from './device-code.js';
import { resolveRegistryToken } from './registry-token.js';
import {
  __setKeytarImporterForTest,
  storeTokens,
  type StoredTokens,
} from './token-store.js';

function accessToken(claims: Record<string, unknown>): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'none', typ: 'JWT' })}.${encode(claims)}.`;
}

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { 'content-type': 'application/json', ...init?.headers },
  });
}

describe('resolveRegistryToken', () => {
  const originalAsrToken = process.env.ASR_TOKEN;
  const originalClientId = process.env.ASR_ENTRA_CLIENT_ID;
  const originalScope = process.env.ASR_ENTRA_SCOPE;
  const originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
  let configHome: string;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    configHome = await mkdtemp(join(tmpdir(), 'asr-registry-token-'));
    process.env.XDG_CONFIG_HOME = configHome;
    process.env.ASR_ENTRA_CLIENT_ID = 'client-id';
    process.env.ASR_ENTRA_SCOPE = 'api://asr/access_as_user offline_access';
    delete process.env.ASR_TOKEN;
    __setKeytarImporterForTest(async () => {
      throw new Error('keytar unavailable');
    });
  });

  afterEach(async () => {
    vi.useRealTimers();
    await rm(configHome, { recursive: true, force: true });

    if (originalAsrToken === undefined) {
      delete process.env.ASR_TOKEN;
    } else {
      process.env.ASR_TOKEN = originalAsrToken;
    }

    if (originalClientId === undefined) {
      delete process.env.ASR_ENTRA_CLIENT_ID;
    } else {
      process.env.ASR_ENTRA_CLIENT_ID = originalClientId;
    }

    if (originalScope === undefined) {
      delete process.env.ASR_ENTRA_SCOPE;
    } else {
      process.env.ASR_ENTRA_SCOPE = originalScope;
    }

    if (originalXdgConfigHome === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
    }
  });

  it('prefers explicit, environment, then config token overrides', async () => {
    await expect(
      resolveRegistryToken({ explicitToken: 'cli-token', configToken: 'config-token' }),
    ).resolves.toBe('cli-token');

    process.env.ASR_TOKEN = 'env-token';
    await expect(resolveRegistryToken({ configToken: 'config-token' })).resolves.toBe(
      'env-token',
    );

    delete process.env.ASR_TOKEN;
    await expect(resolveRegistryToken({ configToken: 'config-token' })).resolves.toBe(
      'config-token',
    );
  });

  it('returns undefined when no override or stored token exists', async () => {
    await expect(resolveRegistryToken()).resolves.toBeUndefined();
  });

  it('returns a fresh stored keyring token without refreshing', async () => {
    const stored: StoredTokens = {
      accessToken: accessToken({ preferred_username: 'user@example.com' }),
      refreshToken: 'refresh-1',
      expiresAt: Date.now() + 10 * 60 * 1000,
      account: 'user@example.com',
    };
    await storeTokens(stored);
    const fetchMock = vi.fn<FetchLike>();

    await expect(
      resolveRegistryToken({ baseUrl: 'https://registry.example.com', fetch: fetchMock }),
    ).resolves.toBe(stored.accessToken);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refreshes an expired stored keyring token', async () => {
    const newToken = accessToken({ preferred_username: 'user@example.com' });
    await storeTokens({
      accessToken: accessToken({ preferred_username: 'user@example.com' }),
      refreshToken: 'refresh-1',
      expiresAt: Date.now() - 60_000,
      account: 'user@example.com',
    });
    const fetchMock = vi.fn<FetchLike>(async () =>
      jsonResponse({ access_token: newToken, expires_in: 3600 }),
    );

    await expect(
      resolveRegistryToken({ baseUrl: 'https://registry.example.com', fetch: fetchMock }),
    ).resolves.toBe(newToken);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('returns undefined when the stored token cannot be refreshed', async () => {
    await storeTokens({
      accessToken: accessToken({ preferred_username: 'user@example.com' }),
      expiresAt: Date.now() - 60_000,
      account: 'user@example.com',
    });

    await expect(
      resolveRegistryToken({ baseUrl: 'https://registry.example.com' }),
    ).resolves.toBeUndefined();
  });
});
