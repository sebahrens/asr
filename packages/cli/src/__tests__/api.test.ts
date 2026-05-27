import { Buffer } from 'buffer';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FetchLike } from '../auth/device-code.js';
import {
  __setKeytarImporterForTest,
  storeTokens,
  type StoredTokens,
} from '../auth/token-store.js';
import { ApiError, apiFetch, mintDerivedToken, postSubmission } from '../api.js';

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { 'content-type': 'application/json', ...init?.headers },
  });
}

function accessTokenString(claims: Record<string, unknown>): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'none', typ: 'JWT' })}.${encode(claims)}.`;
}

describe('apiFetch', () => {
  const originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
  const originalAsrUrl = process.env.ASR_URL;
  let configHome: string;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    configHome = await mkdtemp(join(tmpdir(), 'asr-api-'));
    process.env.XDG_CONFIG_HOME = configHome;
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

    if (originalAsrUrl === undefined) {
      delete process.env.ASR_URL;
    } else {
      process.env.ASR_URL = originalAsrUrl;
    }
  });

  it('attaches a bearer Authorization header when auth is enabled', async () => {
    process.env.ASR_URL = 'https://api.example.com';
    const stored: StoredTokens = {
      accessToken: accessTokenString({ preferred_username: 'u@example.com' }),
      refreshToken: 'refresh-1',
      expiresAt: Date.now() + 60 * 60 * 1000,
      account: 'u@example.com',
    };
    await storeTokens(stored);

    const fetchMock = vi.fn<FetchLike>(async () => jsonResponse({ ok: true }));
    await apiFetch('/api/v1/ping', { fetch: fetchMock });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toBe('https://api.example.com/api/v1/ping');
    const headers = init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${stored.accessToken}`);
    expect(headers.Accept).toBe('application/json');
  });

  it('omits Authorization header when ASR_URL is non-HTTPS', async () => {
    process.env.ASR_URL = 'http://localhost:3001';
    const fetchMock = vi.fn<FetchLike>(async () => jsonResponse({ ok: true }));

    await apiFetch('/api/v1/ping', { fetch: fetchMock });

    const [, init] = fetchMock.mock.calls[0] ?? [];
    const headers = init?.headers as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
  });

  it('throws ApiError with parsed body on non-2xx responses', async () => {
    process.env.ASR_URL = 'http://localhost:3001';
    const fetchMock = vi.fn<FetchLike>(async () =>
      jsonResponse({ error: 'version_already_exists' }, { status: 409 })
    );

    try {
      await apiFetch('/api/v1/submissions', { method: 'POST', fetch: fetchMock });
      expect.fail('expected ApiError');
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      const e = err as ApiError;
      expect(e.status).toBe(409);
      expect(e.body.error).toBe('version_already_exists');
    }
  });

  it('throws when no API URL is configured', async () => {
    delete process.env.ASR_URL;
    await expect(apiFetch('/api/v1/ping', { fetch: vi.fn<FetchLike>() })).rejects.toThrow(
      /Set ASR_URL/
    );
  });
});

describe('postSubmission', () => {
  const originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
  const originalAsrUrl = process.env.ASR_URL;
  let configHome: string;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    configHome = await mkdtemp(join(tmpdir(), 'asr-api-'));
    process.env.XDG_CONFIG_HOME = configHome;
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

    if (originalAsrUrl === undefined) {
      delete process.env.ASR_URL;
    } else {
      process.env.ASR_URL = originalAsrUrl;
    }
  });

  it('returns the parsed 201 body and sends Authorization when auth is enabled', async () => {
    process.env.ASR_URL = 'https://api.example.com';
    const stored: StoredTokens = {
      accessToken: accessTokenString({ preferred_username: 'u@example.com' }),
      refreshToken: 'refresh-1',
      expiresAt: Date.now() + 60 * 60 * 1000,
      account: 'u@example.com',
    };
    await storeTokens(stored);

    const responseBody = {
      id: '01J0000000000000000000000A',
      status: { phase: 'uploaded' as const },
      manifest: { name: 'demo', version: '1.0.0' },
      contentHash: 'sha256:abc',
      createdAt: '2026-05-27T00:00:00.000Z',
    };
    const fetchMock = vi.fn<FetchLike>(async () => jsonResponse(responseBody, { status: 201 }));

    const buf = Buffer.from('zipdata');
    const result = await postSubmission(buf, 'demo.zip', { fetch: fetchMock });

    expect(result).toEqual(responseBody);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toBe('https://api.example.com/api/v1/submissions');
    expect(init?.method).toBe('POST');
    const headers = init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${stored.accessToken}`);
    expect(init?.body).toBeInstanceOf(FormData);
    const form = init?.body as FormData;
    const file = form.get('file');
    expect(file).toBeInstanceOf(Blob);
    expect((file as File).name ?? 'demo.zip').toBe('demo.zip');
    expect((file as Blob).type).toBe('application/zip');
  });

  it('omits Authorization when ASR_URL is non-HTTPS', async () => {
    process.env.ASR_URL = 'http://localhost:3001';
    const fetchMock = vi.fn<FetchLike>(async () =>
      jsonResponse(
        {
          id: '01J0000000000000000000000B',
          status: { phase: 'uploaded' },
          manifest: { name: 'demo', version: '1.0.0' },
          contentHash: 'sha256:abc',
          createdAt: '2026-05-27T00:00:00.000Z',
        },
        { status: 201 }
      )
    );

    await postSubmission(Buffer.from('zipdata'), 'demo.zip', { fetch: fetchMock });

    const [, init] = fetchMock.mock.calls[0] ?? [];
    const headers = init?.headers as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
  });

  it('surfaces a 409 response as ApiError exposing body.error', async () => {
    process.env.ASR_URL = 'http://localhost:3001';
    const fetchMock = vi.fn<FetchLike>(async () =>
      jsonResponse({ error: 'version_already_exists' }, { status: 409 })
    );

    try {
      await postSubmission(Buffer.from('zipdata'), 'demo.zip', { fetch: fetchMock });
      expect.fail('expected ApiError');
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      const e = err as ApiError;
      expect(e.status).toBe(409);
      expect(e.body.error).toBe('version_already_exists');
    }
  });
});

describe('mintDerivedToken', () => {
  const originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
  const originalAsrUrl = process.env.ASR_URL;
  let configHome: string;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    configHome = await mkdtemp(join(tmpdir(), 'asr-api-'));
    process.env.XDG_CONFIG_HOME = configHome;
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

    if (originalAsrUrl === undefined) {
      delete process.env.ASR_URL;
    } else {
      process.env.ASR_URL = originalAsrUrl;
    }
  });

  it('returns body.token and sends Authorization when auth is enabled', async () => {
    process.env.ASR_URL = 'https://api.example.com';
    const stored: StoredTokens = {
      accessToken: accessTokenString({ preferred_username: 'u@example.com' }),
      refreshToken: 'refresh-1',
      expiresAt: Date.now() + 60 * 60 * 1000,
      account: 'u@example.com',
    };
    await storeTokens(stored);

    const expiresAt = new Date(Date.now() + 300_000).toISOString();
    const fetchMock = vi.fn<FetchLike>(async () =>
      jsonResponse({ token: 'short.lived', expiresAt }, { status: 200 })
    );

    const token = await mintDerivedToken({ fetch: fetchMock });

    expect(token).toBe('short.lived');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toBe('https://api.example.com/api/v1/auth/derived-token');
    expect(init?.method).toBe('POST');
    const headers = init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${stored.accessToken}`);
  });

  it('surfaces a 401 response as ApiError exposing body.error', async () => {
    process.env.ASR_URL = 'http://localhost:3001';
    const fetchMock = vi.fn<FetchLike>(async () =>
      jsonResponse({ error: 'unauthorized' }, { status: 401 })
    );

    try {
      await mintDerivedToken({ fetch: fetchMock });
      expect.fail('expected ApiError');
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      const e = err as ApiError;
      expect(e.status).toBe(401);
      expect(e.body.error).toBe('unauthorized');
    }
  });
});
