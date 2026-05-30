import { createHash } from 'node:crypto';

export const DEFAULT_DOWNLOAD_MAX_BYTES = 100 * 1024 * 1024;

export class HashMismatchError extends Error {
  readonly code = 'version.hash.mismatch' as const;
  readonly expected: string;
  readonly actual: string;

  constructor(expected: string, actual: string) {
    super(`Hash mismatch: expected ${expected}, got ${actual}`);
    this.name = 'HashMismatchError';
    this.expected = expected;
    this.actual = actual;
  }
}

export class DownloadSizeLimitError extends Error {
  readonly code = 'download.size_limit_exceeded' as const;
  readonly maxBytes: number;
  readonly actualBytes?: number;

  constructor(maxBytes: number, actualBytes?: number) {
    const actual = actualBytes === undefined ? 'unknown' : String(actualBytes);
    super(`Download size limit exceeded: max ${maxBytes} bytes, got ${actual} bytes`);
    this.name = 'DownloadSizeLimitError';
    this.maxBytes = maxBytes;
    this.actualBytes = actualBytes;
  }
}

export interface DownloadOptions {
  token?: string;
  maxBytes?: number;
}

export async function downloadAndVerify(
  url: string,
  expectedHash: string,
  opts: DownloadOptions = {},
): Promise<Buffer> {
  const maxBytes = opts.maxBytes ?? DEFAULT_DOWNLOAD_MAX_BYTES;
  const res = await fetch(url, { headers: {}, redirect: 'follow' });
  if (!res.ok) {
    throw new Error(`Download failed: ${res.status} ${res.statusText}`);
  }

  const contentLength = parseContentLength(res.headers.get('content-length'));
  if (contentLength !== undefined && contentLength > maxBytes) {
    await res.body?.cancel().catch(() => undefined);
    throw new DownloadSizeLimitError(maxBytes, contentLength);
  }

  const hash = createHash('sha256');
  const chunks: Buffer[] = [];
  let totalBytes = 0;

  if (res.body) {
    const reader = res.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }

        const chunk = Buffer.from(value);
        totalBytes += chunk.byteLength;
        if (totalBytes > maxBytes) {
          await reader.cancel().catch(() => undefined);
          throw new DownloadSizeLimitError(maxBytes, totalBytes);
        }

        hash.update(chunk);
        chunks.push(chunk);
      }
    } finally {
      reader.releaseLock();
    }
  }

  const buf = Buffer.concat(chunks, totalBytes);
  const actual = `sha256:${hash.digest('hex')}`;

  if (actual.toLowerCase() !== expectedHash.toLowerCase()) {
    throw new HashMismatchError(expectedHash, actual);
  }

  return buf;
}

function parseContentLength(value: string | null): number | undefined {
  if (value === null) {
    return undefined;
  }

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    return undefined;
  }

  return parsed;
}
