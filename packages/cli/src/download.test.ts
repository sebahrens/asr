import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DownloadSizeLimitError, HashMismatchError, downloadAndVerify } from './download.js';

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

  it('streams the payload instead of reading it with arrayBuffer', async () => {
    const res = bytesResponse(BODY);
    res.arrayBuffer = vi.fn(async () => {
      throw new Error('arrayBuffer should not be called');
    });
    fetchSpy.mockResolvedValueOnce(res);

    const result = await downloadAndVerify(URL_, hashOf(BODY));

    expect(result.equals(BODY)).toBe(true);
    expect(res.arrayBuffer).not.toHaveBeenCalled();
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

  it('does not attach Bearer authorization to artifact downloads when token is supplied', async () => {
    fetchSpy.mockResolvedValueOnce(bytesResponse(BODY));

    await downloadAndVerify(URL_, hashOf(BODY), { token: 't0k' });

    const [, init] = fetchSpy.mock.calls[0];
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
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

  it('does not leak Bearer authorization to a cross-origin redirect target', async () => {
    vi.unstubAllGlobals();
    let redirectedAuthorization: string | undefined;

    const target = await listen((req, res) => {
      redirectedAuthorization = req.headers.authorization;
      res.writeHead(200, { 'Content-Type': 'application/zip' });
      res.end(BODY);
    });

    const registry = await listen((_req, res) => {
      res.writeHead(302, { Location: target.url });
      res.end();
    });

    try {
      const result = await downloadAndVerify(registry.url, hashOf(BODY), { token: 't0k' });

      expect(result.equals(BODY)).toBe(true);
      expect(redirectedAuthorization).toBeUndefined();
    } finally {
      await Promise.all([registry.close(), target.close()]);
    }
  });

  it('throws on non-2xx response', async () => {
    fetchSpy.mockResolvedValueOnce(new Response('not found', { status: 404 }));

    await expect(downloadAndVerify(URL_, hashOf(BODY))).rejects.toThrow(/404/);
  });

  it('rejects with typed error when Content-Length exceeds the configured cap', async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      cancel,
      start(controller) {
        controller.enqueue(new Uint8Array(BODY));
      },
    });
    fetchSpy.mockResolvedValueOnce(
      new Response(stream, {
        status: 200,
        headers: { 'Content-Length': '11', 'Content-Type': 'application/zip' },
      }),
    );

    await expect(downloadAndVerify(URL_, hashOf(BODY), { maxBytes: 10 })).rejects.toMatchObject({
      name: 'DownloadSizeLimitError',
      code: 'download.size_limit_exceeded',
      maxBytes: 10,
      actualBytes: 11,
    });
    expect(cancel).toHaveBeenCalled();
  });

  it('cancels the response stream when cumulative bytes exceed the cap', async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      cancel,
      start(controller) {
        controller.enqueue(new Uint8Array(Buffer.from('12345')));
        controller.enqueue(new Uint8Array(Buffer.from('67890')));
      },
    });
    fetchSpy.mockResolvedValueOnce(new Response(stream, { status: 200 }));

    await expect(downloadAndVerify(URL_, hashOf(BODY), { maxBytes: 8 })).rejects.toBeInstanceOf(
      DownloadSizeLimitError,
    );
    expect(cancel).toHaveBeenCalled();
  });
});

async function listen(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Expected HTTP server to listen on a TCP port');
  }
  return {
    url: `http://127.0.0.1:${address.port}/download`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
