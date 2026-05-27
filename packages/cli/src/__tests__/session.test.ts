import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FetchLike } from '../auth/device-code.js';
import { AuthRequiredError, getValidAccessToken } from '../auth/session.js';
import {
  __setKeytarImporterForTest,
  getStoredTokens,
  storeTokens,
  type StoredTokens,
} from '../auth/token-store.js';

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { 'content-type': 'application/json', ...init?.headers },
  });
}

function accessToken(claims: Record<string, unknown>): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'none', typ: 'JWT' })}.${encode(claims)}.`;
}

describe('getValidAccessToken', () => {
  const originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
  const originalClientId = process.env.ASR_ENTRA_CLIENT_ID;
  const originalScope = process.env.ASR_ENTRA_SCOPE;
  const baseUrl = 'https://login.example.test/oauth2/v2.0';
  let configHome: string;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    configHome = await mkdtemp(join(tmpdir(), 'asr-session-'));
    process.env.XDG_CONFIG_HOME = configHome;
    process.env.ASR_ENTRA_CLIENT_ID = 'client-id';
    process.env.ASR_ENTRA_SCOPE = 'api://asr/access_as_user offline_access';
    __setKeytarImporterForTest(async () => {
      throw new Error('keytar unavailable');
    });
  });

  afterEach(async () => {
    vi.useRealTimers();
    await rm(configHome, { recursive: true, force: true });

    if (originalXdgConfigHome === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
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
  });

  it('returns the stored access token unchanged when it is not near expiry', async () => {
    const stored: StoredTokens = {
      accessToken: accessToken({ preferred_username: 'user@example.com' }),
      refreshToken: 'refresh-1',
      expiresAt: Date.now() + 10 * 60 * 1000,
      account: 'user@example.com',
    };
    await storeTokens(stored);
    const fetchMock = vi.fn<FetchLike>();

    await expect(getValidAccessToken(baseUrl, { fetch: fetchMock })).resolves.toBe(stored.accessToken);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refreshes and persists new tokens when the access token is expired and refresh succeeds', async () => {
    const oldToken = accessToken({ preferred_username: 'user@example.com' });
    const newToken = accessToken({ preferred_username: 'user@example.com' });
    await storeTokens({
      accessToken: oldToken,
      refreshToken: 'refresh-1',
      expiresAt: Date.now() - 60_000,
      account: 'user@example.com',
    });

    const fetchMock = vi.fn<FetchLike>(async () =>
      jsonResponse({
        access_token: newToken,
        refresh_token: 'refresh-2',
        expires_in: 3600,
      })
    );

    await expect(getValidAccessToken(baseUrl, { fetch: fetchMock })).resolves.toBe(newToken);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toBe('https://login.example.test/oauth2/v2.0/token');
    expect(init?.method).toBe('POST');
    const body = init?.body;
    expect(body).toBeInstanceOf(URLSearchParams);
    expect((body as URLSearchParams).get('grant_type')).toBe('refresh_token');
    expect((body as URLSearchParams).get('client_id')).toBe('client-id');
    expect((body as URLSearchParams).get('refresh_token')).toBe('refresh-1');
    expect((body as URLSearchParams).get('scope')).toBe('api://asr/access_as_user offline_access');

    await expect(getStoredTokens()).resolves.toEqual({
      accessToken: newToken,
      refreshToken: 'refresh-2',
      expiresAt: Date.now() + 3600 * 1000,
      account: 'user@example.com',
    });
  });

  it('preserves the existing refresh token when the response omits a rotated one', async () => {
    const newToken = accessToken({ preferred_username: 'user@example.com' });
    await storeTokens({
      accessToken: accessToken({ preferred_username: 'user@example.com' }),
      refreshToken: 'refresh-1',
      expiresAt: Date.now() - 60_000,
      account: 'user@example.com',
    });

    const fetchMock = vi.fn<FetchLike>(async () =>
      jsonResponse({ access_token: newToken, expires_in: 3600 })
    );

    await expect(getValidAccessToken(baseUrl, { fetch: fetchMock })).resolves.toBe(newToken);
    await expect(getStoredTokens()).resolves.toMatchObject({ refreshToken: 'refresh-1' });
  });

  it('throws AuthRequiredError when the refresh request is rejected', async () => {
    await storeTokens({
      accessToken: accessToken({ preferred_username: 'user@example.com' }),
      refreshToken: 'expired-refresh',
      expiresAt: Date.now() - 60_000,
      account: 'user@example.com',
    });

    const fetchMock = vi.fn<FetchLike>(async () =>
      jsonResponse(
        { error: 'invalid_grant', error_description: 'refresh token expired' },
        { status: 400 }
      )
    );

    await expect(getValidAccessToken(baseUrl, { fetch: fetchMock })).rejects.toBeInstanceOf(
      AuthRequiredError
    );
  });

  it('throws AuthRequiredError when no tokens are stored', async () => {
    const fetchMock = vi.fn<FetchLike>();

    await expect(getValidAccessToken(baseUrl, { fetch: fetchMock })).rejects.toBeInstanceOf(
      AuthRequiredError
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('throws AuthRequiredError when the access token is expired and no refresh token is stored', async () => {
    await storeTokens({
      accessToken: accessToken({ preferred_username: 'user@example.com' }),
      expiresAt: Date.now() - 60_000,
      account: 'user@example.com',
    });
    const fetchMock = vi.fn<FetchLike>();

    await expect(getValidAccessToken(baseUrl, { fetch: fetchMock })).rejects.toBeInstanceOf(
      AuthRequiredError
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
