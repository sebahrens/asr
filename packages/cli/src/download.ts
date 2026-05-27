import { createHash } from 'node:crypto';

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

export interface DownloadOptions {
  token?: string;
}

export async function downloadAndVerify(
  url: string,
  expectedHash: string,
  opts: DownloadOptions = {},
): Promise<Buffer> {
  const headers: Record<string, string> = {};
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;

  const res = await fetch(url, { headers, redirect: 'follow' });
  if (!res.ok) {
    throw new Error(`Download failed: ${res.status} ${res.statusText}`);
  }

  const buf = Buffer.from(await res.arrayBuffer());
  const actual = `sha256:${createHash('sha256').update(buf).digest('hex')}`;

  if (actual.toLowerCase() !== expectedHash.toLowerCase()) {
    throw new HashMismatchError(expectedHash, actual);
  }

  return buf;
}
