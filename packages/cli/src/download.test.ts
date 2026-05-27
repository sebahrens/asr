import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HashMismatchError, downloadAndVerify } from './download.js';

function hashOf(buf: Buffer): string {
  return `sha256:${createHash('sha256').update(buf).digest('hex')}`;
}

function bytesResponse(buf: Buffer, status = 200): Response {
  return new Response(new Uint8Array(buf), {
    status,
    headers: { 'Content-Type': 'application/zip' },
  });
}

describe('downloadAndVerify', () => {
  const fetchSpy = vi.fn<typeof fetch>();
  const URL_ = 'http://localhost:3001/api/v1/skills/acme/x/v1.0.0/download';
  const BODY = Buffer.from('PK\x03\x04test-payload');

  beforeEach(() => {
    fetchSpy.mockReset();
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('rejects with code version.hash.mismatch on wrong hash', async () => {
    fetchSpy.mockResolvedValueOnce(bytesResponse(BODY));

    await expect(
      downloadAndVerify(URL_, 'sha256:0000000000000000000000000000000000000000000000000000000000000000'),
    ).rejects.toMatchObject({
      name: 'HashMismatchError',
      code: 'version.hash.mismatch',
    });
  });

  it('resolves to a Buffer when hash matches', async () => {
    fetchSpy.mockResolvedValueOnce(bytesResponse(BODY));

    const result = await downloadAndVerify(URL_, hashOf(BODY));

    expect(Buffer.isBuffer(result)).toBe(true);
    expect(result.equals(BODY)).toBe(true);
  });

  it('compares hashes case-insensitively', async () => {
    fetchSpy.mockResolvedValueOnce(bytesResponse(BODY));

    const expected = hashOf(BODY).toUpperCase();
    const result = await downloadAndVerify(URL_, expected);

    expect(result.equals(BODY)).toBe(true);
  });

  it('includes both hashes in the error message', async () => {
    fetchSpy.mockResolvedValueOnce(bytesResponse(BODY));
    const wrong = 'sha256:0000000000000000000000000000000000000000000000000000000000000000';

    try {
      await downloadAndVerify(URL_, wrong);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(HashMismatchError);
      const e = err as HashMismatchError;
      expect(e.expected).toBe(wrong);
      expect(e.actual).toBe(hashOf(BODY));
      expect(e.message).toContain(wrong);
      expect(e.message).toContain(hashOf(BODY));
    }
  });

  it('attaches Bearer authorization only when token is supplied', async () => {
    fetchSpy.mockResolvedValueOnce(bytesResponse(BODY));

    await downloadAndVerify(URL_, hashOf(BODY), { token: 't0k' });

    const [, init] = fetchSpy.mock.calls[0];
    expect((init as RequestInit).headers).toMatchObject({ Authorization: 'Bearer t0k' });
  });

  it('omits Authorization header when no token', async () => {
    fetchSpy.mockResolvedValueOnce(bytesResponse(BODY));

    await downloadAndVerify(URL_, hashOf(BODY));

    const [, init] = fetchSpy.mock.calls[0];
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
  });

  it('follows redirects (redirect: follow)', async () => {
    fetchSpy.mockResolvedValueOnce(bytesResponse(BODY));

    await downloadAndVerify(URL_, hashOf(BODY));

    const [, init] = fetchSpy.mock.calls[0];
    expect((init as RequestInit).redirect).toBe('follow');
  });

  it('throws on non-2xx response', async () => {
    fetchSpy.mockResolvedValueOnce(new Response('not found', { status: 404 }));

    await expect(downloadAndVerify(URL_, hashOf(BODY))).rejects.toThrow(/404/);
  });
});
