import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import yauzl from 'yauzl';

export class PathTraversalError extends Error {
  readonly code = 'extract.path_traversal' as const;
  readonly entry: string;

  constructor(entry: string) {
    super(`Refusing to extract entry outside destDir: ${entry}`);
    this.name = 'PathTraversalError';
    this.entry = entry;
  }
}

export async function extractZip(zip: Buffer, destDir: string): Promise<string[]> {
  const canonical = resolve(destDir);
  await mkdir(canonical, { recursive: true });

  const archive = await openBuffer(zip);
  const written: string[] = [];

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
      void processEntry(archive, entry, canonical, written)
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
): Promise<void> {
  const name = entry.fileName;

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

  const isDirectory = name.endsWith('/');
  if (isDirectory) {
    await mkdir(entryPath, { recursive: true });
    return;
  }

  await mkdir(dirname(entryPath), { recursive: true });
  const stream = await openReadStream(archive, entry);
  await pipeline(stream, createWriteStream(entryPath, { flags: 'wx' }));
  written.push(rel.split(sep).join('/'));
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
