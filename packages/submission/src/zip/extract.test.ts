import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import yazl from 'yazl';
import { extractSafe } from './extract.js';

let tempDir: string;
let zipPath: string;
let targetDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'asr-extract-'));
  zipPath = join(tempDir, 'fixture.zip');
  targetDir = join(tempDir, 'out');
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe('extractSafe', () => {
  it('rejects path traversal entries', async () => {
    await writeZip([{ path: 'xxxevil.txt', contents: 'owned' }]);
    await replaceZipPath('xxxevil.txt', '../evil.txt');

    await expect(extractSafe(zipPath, targetDir)).rejects.toThrow(/path traversal/);
  });

  it('rejects archives that exceed the file count limit', async () => {
    await writeZip([
      { path: 'one.txt', contents: 'one' },
      { path: 'two.txt', contents: 'two' },
    ]);

    await expect(extractSafe(zipPath, targetDir, limits({ maxFiles: 1 }))).rejects.toThrow(/max files/);
  });

  it('extracts safe entries and returns relative file paths', async () => {
    await writeZip([
      { path: 'SKILL.md', contents: '# Skill' },
      { path: 'docs/readme.txt', contents: 'details' },
    ]);

    await expect(extractSafe(zipPath, targetDir)).resolves.toEqual(['SKILL.md', 'docs/readme.txt']);
  });
});

async function writeZip(entries: Array<{ path: string; contents: string }>): Promise<void> {
  const zip = new yazl.ZipFile();
  for (const entry of entries) {
    zip.addBuffer(Buffer.from(entry.contents), entry.path);
  }
  zip.end();

  await writeFileFromStream(zip.outputStream);
}

async function replaceZipPath(from: string, to: string): Promise<void> {
  if (Buffer.byteLength(from) !== Buffer.byteLength(to)) {
    throw new Error('zip path replacements must preserve byte length');
  }

  let zipBuffer = await readFile(zipPath);
  const fromBuffer = Buffer.from(from);
  const toBuffer = Buffer.from(to);

  let offset = zipBuffer.indexOf(fromBuffer);
  while (offset !== -1) {
    zipBuffer = Buffer.concat([
      zipBuffer.subarray(0, offset),
      toBuffer,
      zipBuffer.subarray(offset + fromBuffer.length),
    ]);
    offset = zipBuffer.indexOf(fromBuffer, offset + toBuffer.length);
  }

  await writeFile(zipPath, zipBuffer);
}

function writeFileFromStream(stream: NodeJS.ReadableStream): Promise<void> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on('data', (chunk: Buffer) => chunks.push(chunk));
    stream.on('end', () => {
      void writeFile(zipPath, Buffer.concat(chunks)).then(resolve, reject);
    });
    stream.on('error', reject);
  });
}

function limits(overrides: Partial<Parameters<typeof extractSafe>[2]>): NonNullable<Parameters<typeof extractSafe>[2]> {
  return {
    maxCompressedBytes: 50 * 1024 * 1024,
    maxUncompressedBytes: 200 * 1024 * 1024,
    maxFiles: 500,
    maxDepth: 5,
    maxPathLen: 200,
    ...overrides,
  };
}
