import { createWriteStream, statSync } from 'node:fs';
import { mkdir, unlink } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';
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

export async function extractSafe(
  zipPath: string,
  targetDir: string,
  limits: ExtractLimits = LIMITS,
): Promise<string[]> {
  const canonical = resolve(targetDir);
  await mkdir(canonical, { recursive: true });

  if (statSync(zipPath).size > limits.maxCompressedBytes) {
    throw new Error('compressed size limit');
  }

  const zip = await openZip(zipPath);

  let totalUncompressedBytes = 0;
  let fileCount = 0;
  const files: string[] = [];

  return new Promise((resolveFiles, rejectFiles) => {
    let settled = false;

    const rejectOnce = (error: unknown) => {
      if (settled) {
        return;
      }

      settled = true;
      zip.close();
      if (error instanceof Error && /^(absolute path|invalid relative path):/.test(error.message)) {
        rejectFiles(new Error(`path traversal: ${error.message}`));
        return;
      }

      rejectFiles(error);
    };

    const readNext = () => {
      if (!settled) {
        zip.readEntry();
      }
    };

    zip.on('entry', (entry) => {
      void extractEntry(entry)
        .then(readNext)
        .catch(rejectOnce);
    });

    zip.on('end', () => {
      if (settled) {
        return;
      }

      settled = true;
      resolveFiles(files);
    });

    zip.on('error', rejectOnce);
    readNext();
  });

  async function extractEntry(entry: yauzl.Entry): Promise<void> {
    const name = entry.fileName.normalize('NFC');

    if (name.length > limits.maxPathLen) {
      throw new Error(`path too long: ${name}`);
    }

    if (ILLEGAL_CHARS.test(name)) {
      throw new Error(`illegal chars: ${name}`);
    }

    const entryPath = resolve(canonical, name);
    const relativePath = relative(canonical, entryPath);
    if (relativePath.startsWith('..') || relativePath === '' || resolve(canonical, relativePath) !== entryPath) {
      throw new Error(`path traversal: ${name}`);
    }

    if (relativePath.split(sep).length > limits.maxDepth) {
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

    if (++fileCount > limits.maxFiles) {
      throw new Error('max files');
    }

    if (isDirectory) {
      await mkdir(entryPath, { recursive: true });
      return;
    }

    await mkdir(dirname(entryPath), { recursive: true });
    let entryBytes = 0;
    try {
      await pipeline(
        await openReadStream(zip, entry),
        new ByteLimitTransform((bytes) => {
          entryBytes += bytes;
          totalUncompressedBytes += bytes;
          if (entryBytes > limits.maxUncompressedBytes || totalUncompressedBytes > limits.maxUncompressedBytes) {
            throw new Error('uncompressed size limit');
          }
        }),
        createWriteStream(entryPath, { flags: 'wx' }),
      );

      const writtenBytes = statSync(entryPath).size;
      if (writtenBytes !== entryBytes) {
        throw new Error(`zip extraction size mismatch: ${name}`);
      }
    } catch (error) {
      await unlink(entryPath).catch((unlinkError: NodeJS.ErrnoException) => {
        if (unlinkError.code !== 'ENOENT') {
          throw unlinkError;
        }
      });
      throw error;
    }

    files.push(relativePath);
  }
}

class ByteLimitTransform extends Transform {
  constructor(private readonly addBytes: (bytes: number) => void) {
    super();
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    try {
      this.addBytes(chunk.byteLength);
      callback(null, chunk);
    } catch (error) {
      callback(error instanceof Error ? error : new Error(String(error)));
    }
  }
}

function openReadStream(zip: yauzl.ZipFile, entry: yauzl.Entry): Promise<NodeJS.ReadableStream> {
  return new Promise((resolveStream, rejectStream) => {
    zip.openReadStream(entry, (error, stream) => {
      if (error) {
        rejectStream(error);
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

function openZip(path: string): Promise<yauzl.ZipFile> {
  return new Promise((resolveZip, rejectZip) => {
    yauzl.open(path, { lazyEntries: true, autoClose: true, validateEntrySizes: false }, (error, zip) => {
      if (error) {
        rejectZip(error);
        return;
      }

      if (!zip) {
        rejectZip(new Error('failed to open zip'));
        return;
      }

      resolveZip(zip);
    });
  });
}
