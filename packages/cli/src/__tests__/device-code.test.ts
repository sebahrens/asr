import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pollForToken, requestDeviceCode, type FetchLike } from '../auth/device-code.js';

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

describe('device code auth client', () => {
  const originalInterval = process.env.ASR_DEVICE_POLL_INTERVAL_SECONDS;
  const originalTimeout = process.env.ASR_DEVICE_POLL_TIMEOUT_SECONDS;
  const originalClientId = process.env.ASR_ENTRA_CLIENT_ID;
  const originalScope = process.env.ASR_ENTRA_SCOPE;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    process.env.ASR_DEVICE_POLL_INTERVAL_SECONDS = '1';
    process.env.ASR_DEVICE_POLL_TIMEOUT_SECONDS = '20';
    process.env.ASR_ENTRA_CLIENT_ID = 'client-id';
    process.env.ASR_ENTRA_SCOPE = 'api://asr/access_as_user offline_access';
  });

  afterEach(() => {
    vi.useRealTimers();

    if (originalInterval === undefined) {
      delete process.env.ASR_DEVICE_POLL_INTERVAL_SECONDS;
    } else {
      process.env.ASR_DEVICE_POLL_INTERVAL_SECONDS = originalInterval;
    }

    if (originalTimeout === undefined) {
      delete process.env.ASR_DEVICE_POLL_TIMEOUT_SECONDS;
    } else {
      process.env.ASR_DEVICE_POLL_TIMEOUT_SECONDS = originalTimeout;
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

  it('requests and normalizes a device code response', async () => {
    const fetchMock = vi.fn<FetchLike>(async () =>
      jsonResponse({
        verification_uri: 'https://microsoft.com/devicelogin',
        user_code: 'ABCD-EFGH',
        device_code: 'device-code',
        interval: 7,
      })
    );

    await expect(requestDeviceCode('https://login.example.test/oauth2/v2.0', fetchMock)).resolves.toEqual({
      verificationUri: 'https://microsoft.com/devicelogin',
      userCode: 'ABCD-EFGH',
      deviceCode: 'device-code',
      interval: 7,
    });

    expect(fetchMock).toHaveBeenCalledWith(
      new URL('https://login.example.test/oauth2/v2.0/devicecode'),
      expect.objectContaining({ method: 'POST' })
    );
    const [, init] = fetchMock.mock.calls[0] ?? [];
    const body = init?.body;
    expect(body).toBeInstanceOf(URLSearchParams);
    expect((body as URLSearchParams).get('client_id')).toBe('client-id');
    expect((body as URLSearchParams).get('scope')).toBe('api://asr/access_as_user offline_access');
  });

  it('keeps polling on authorization_pending, doubles interval on slow_down, and returns tokens', async () => {
    const callTimes: number[] = [];
    const token = accessToken({ preferred_username: 'user@company.com' });
    const fetchMock = vi
      .fn<FetchLike>()
      .mockImplementation(async () => {
        callTimes.push(Date.now());
        if (callTimes.length === 1) {
          return jsonResponse({ error: 'authorization_pending' }, { status: 400 });
        }
        if (callTimes.length === 2) {
          return jsonResponse({ error: 'slow_down' }, { status: 400 });
        }
        return jsonResponse({
          access_token: token,
          refresh_token: 'refresh-token',
          expires_in: 3600,
        });
      });

    const result = pollForToken('https://login.example.test/oauth2/v2.0', 'device-code', {
      fetch: fetchMock,
    });

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(1000);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await vi.advanceTimersByTimeAsync(2000);

    await expect(result).resolves.toEqual({
      accessToken: token,
      refreshToken: 'refresh-token',
      expiresAt: 3_603_050,
      account: 'user@company.com',
    });
    expect(callTimes).toHaveLength(3);
    expect(callTimes[1] - callTimes[0]).toBe(1050);
    expect(callTimes[2] - callTimes[1]).toBe(2000);
  });

  it('caps slow_down interval at 30 seconds', async () => {
    const callTimes: number[] = [];
    const token = accessToken({ sub: 'user-sub' });
    const fetchMock = vi
      .fn<FetchLike>()
      .mockImplementation(async () => {
        callTimes.push(Date.now());
        if (callTimes.length < 4) {
          return jsonResponse({ error: 'slow_down' }, { status: 400 });
        }
        return jsonResponse({ access_token: token, expires_in: 60 });
      });

    const result = pollForToken('https://login.example.test/oauth2/v2.0', 'device-code', {
      fetch: fetchMock,
      initialIntervalSeconds: 20,
      timeoutSeconds: 120,
    });

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    await vi.advanceTimersByTimeAsync(30_000);

    await expect(result).resolves.toMatchObject({ account: 'user-sub' });
    expect(callTimes).toHaveLength(4);
    expect(callTimes[1] - callTimes[0]).toBe(30_050);
    expect(callTimes[2] - callTimes[1]).toBe(30_000);
    expect(callTimes[3] - callTimes[2]).toBe(30_000);
  });

  it('rejects when polling times out', async () => {
    process.env.ASR_DEVICE_POLL_TIMEOUT_SECONDS = '3';
    const fetchMock = vi.fn<FetchLike>(async () =>
      jsonResponse({ error: 'authorization_pending' }, { status: 400 })
    );

    const result = pollForToken('https://login.example.test/oauth2/v2.0', 'device-code', {
      fetch: fetchMock,
    });
    const rejection = expect(result).rejects.toThrow('timed out after 3 seconds');

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(1000);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await vi.advanceTimersByTimeAsync(1000);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    await vi.advanceTimersByTimeAsync(1000);

    await rejection;
  });
});
