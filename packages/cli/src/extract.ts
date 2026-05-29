import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { Transform, type TransformCallback } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import yauzl from 'yauzl';

export const LIMITS = {
  maxCompressedBytes: 50 * 1024 * 1024,
  maxUncompressedBytes: 200 * 1024 * 1024,
  maxFiles: 500,
  maxDepth: 5,
  maxPathLen: 200,
};

export type ExtractLimits = typeof LIMITS;

const ILLEGAL_CHARS = /[\x00-\x1f\u202e\u200f]/;
const POSIX_FILE_TYPE_MASK = 0xf000;
const POSIX_REGULAR_FILE = 0x8000;
const POSIX_DIRECTORY = 0x4000;
const POSIX_SYMLINK = 0xa000;

export class PathTraversalError extends Error {
  readonly code = 'extract.path_traversal' as const;
  readonly entry: string;

  constructor(entry: string) {
    super(`Refusing to extract entry outside destDir: ${entry}`);
    this.name = 'PathTraversalError';
    this.entry = entry;
  }
}

export async function extractZip(zip: Buffer, destDir: string, limits: ExtractLimits = LIMITS): Promise<string[]> {
  if (zip.byteLength > limits.maxCompressedBytes) {
    throw new Error('compressed size limit');
  }

  const canonical = resolve(destDir);
  await mkdir(canonical, { recursive: true });

  const archive = await openBuffer(zip);
  const written: string[] = [];
  const state = {
    totalCompressedBytes: 0,
    totalUncompressedBytes: 0,
    fileCount: 0,
  };

  return new Promise<string[]>((resolveAll, rejectAll) => {
    let settled = false;

    const fail = (err: unknown) => {
      if (settled) return;
      settled = true;
      archive.close();
      if (err instanceof Error && /^(absolute path|invalid relative path):/.test(err.message)) {
        rejectAll(new PathTraversalError(err.message.replace(/^[^:]+:\s*/, '')));
        return;
      }
      rejectAll(err);
    };

    archive.on('entry', (entry: yauzl.Entry) => {
      void processEntry(archive, entry, canonical, written, limits, state)
        .then(() => {
          if (!settled) archive.readEntry();
        })
        .catch(fail);
    });

    archive.on('end', () => {
      if (settled) return;
      settled = true;
      resolveAll(written);
    });

    archive.on('error', fail);

    archive.readEntry();
  });
}

async function processEntry(
  archive: yauzl.ZipFile,
  entry: yauzl.Entry,
  canonical: string,
  written: string[],
  limits: ExtractLimits,
  state: { totalCompressedBytes: number; totalUncompressedBytes: number; fileCount: number },
): Promise<void> {
  const name = entry.fileName.normalize('NFC');

  if (name.length > limits.maxPathLen) {
    throw new Error(`path too long: ${name}`);
  }

  if (ILLEGAL_CHARS.test(name)) {
    throw new Error(`illegal chars: ${name}`);
  }

  if (isAbsolute(name) || name.startsWith('/') || name.startsWith('\\')) {
    throw new PathTraversalError(name);
  }
  if (name.split(/[\\/]/).some((seg) => seg === '..')) {
    throw new PathTraversalError(name);
  }

  const entryPath = resolve(join(canonical, name));
  const rel = relative(canonical, entryPath);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    throw new PathTraversalError(name);
  }

  if (rel.split(sep).length > limits.maxDepth) {
    throw new Error(`max depth: ${name}`);
  }

  const mode = entry.externalFileAttributes >>> 16;
  const fileType = mode & POSIX_FILE_TYPE_MASK;
  const isDirectory = name.endsWith('/');

  if (fileType === POSIX_SYMLINK) {
    throw new Error(`symlink rejected: ${name}`);
  }

  if (fileType !== 0 && fileType !== POSIX_REGULAR_FILE && fileType !== POSIX_DIRECTORY) {
    throw new Error(`non-regular file rejected: ${name}`);
  }

  if (++state.fileCount > limits.maxFiles) {
    throw new Error('max files');
  }

  state.totalCompressedBytes += entry.compressedSize;
  if (state.totalCompressedBytes > limits.maxCompressedBytes) {
    throw new Error('compressed size limit');
  }

  if (isDirectory) {
    await mkdir(entryPath, { recursive: true });
    return;
  }

  await mkdir(dirname(entryPath), { recursive: true });
  const stream = await openReadStream(archive, entry);
  await pipeline(
    stream,
    new ByteLimitTransform(limits.maxUncompressedBytes, (bytes) => {
      state.totalUncompressedBytes += bytes;
      return state.totalUncompressedBytes;
    }),
    createWriteStream(entryPath, { flags: 'wx' }),
  );
  written.push(rel.split(sep).join('/'));
}

class ByteLimitTransform extends Transform {
  constructor(
    private readonly limit: number,
    private readonly addBytes: (bytes: number) => number,
  ) {
    super();
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    const total = this.addBytes(chunk.byteLength);
    if (total > this.limit) {
      callback(new Error('uncompressed size limit'));
      return;
    }

    callback(null, chunk);
  }
}

function openBuffer(buf: Buffer): Promise<yauzl.ZipFile> {
  return new Promise((resolveZip, rejectZip) => {
    yauzl.fromBuffer(buf, { lazyEntries: true }, (err, zip) => {
      if (err) {
        rejectZip(err);
        return;
      }
      if (!zip) {
        rejectZip(new Error('failed to open zip buffer'));
        return;
      }
      resolveZip(zip);
    });
  });
}

function openReadStream(archive: yauzl.ZipFile, entry: yauzl.Entry): Promise<NodeJS.ReadableStream> {
  return new Promise((resolveStream, rejectStream) => {
    archive.openReadStream(entry, (err, stream) => {
      if (err) {
        rejectStream(err);
        return;
      }
      if (!stream) {
        rejectStream(new Error(`failed to read zip entry: ${entry.fileName}`));
        return;
      }
      resolveStream(stream);
    });
  });
}
