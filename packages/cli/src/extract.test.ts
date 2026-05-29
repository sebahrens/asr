import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import yazl from 'yazl';
import { buildMaliciousZip, type MaliciousZipKind } from '../../submission/test/fixtures/zip/buildMaliciousZips.js';
import { LIMITS, PathTraversalError, extractZip, type ExtractLimits } from './extract.js';

let tempDir: string;
let destDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'asr-cli-extract-'));
  destDir = join(tempDir, 'out');
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe('extractZip', () => {
  it('writes both files under destDir and returns their relative paths', async () => {
    const buf = await buildZip([
      { path: 'SKILL.md', contents: '# Skill' },
      { path: 'docs/readme.txt', contents: 'details' },
    ]);

    const written = await extractZip(buf, destDir);

    expect(written.sort()).toEqual(['SKILL.md', 'docs/readme.txt'].sort());
    await expect(readFile(join(destDir, 'SKILL.md'), 'utf8')).resolves.toBe('# Skill');
    await expect(readFile(join(destDir, 'docs', 'readme.txt'), 'utf8')).resolves.toBe('details');
  });

  it('rejects a ../ traversal entry without writing outside destDir', async () => {
    const buf = await buildZip([{ path: 'xxxevil.txt', contents: 'owned' }]);
    const patched = replaceBytes(buf, 'xxxevil.txt', '../evil.txt');

    await expect(extractZip(patched, destDir)).rejects.toBeInstanceOf(PathTraversalError);

    await expect(readFile(join(tempDir, 'evil.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });

    const remaining = await readdir(destDir).catch(() => [] as string[]);
    expect(remaining.filter((n) => n.endsWith('evil.txt'))).toEqual([]);
  });

  it('rejects an absolute-path entry', async () => {
    const buf = await buildZip([{ path: 'aaaaaa.txt', contents: 'x' }]);
    const patched = replaceBytes(buf, 'aaaaaa.txt', '/etc/x.txt');

    await expect(extractZip(patched, destDir)).rejects.toBeInstanceOf(PathTraversalError);
  });

  it('rejects excessive directory nesting fixture with max depth', async () => {
    await expectRejects('maxDepth', /max depth/);
  });

  it('rejects symlink fixture with symlink rejected', async () => {
    await expectRejects('symlink', /symlink rejected/);
  });

  it('rejects streamed uncompressed bytes over the limit', async () => {
    await expectRejects('uncompressedSize', /uncompressed size limit/, { maxUncompressedBytes: 20 });
  });

  it('rejects excessive file-count fixture with max files', async () => {
    await expectRejects('maxFiles', /max files/, { maxFiles: 2 });
  });

  it('rejects excessive filename length fixture with path too long', async () => {
    await expectRejects('maxPathLen', /path too long/, { maxPathLen: 12 });
  });
});

async function expectRejects(
  kind: MaliciousZipKind,
  error: RegExp,
  limitOverrides: Partial<ExtractLimits> = {},
): Promise<void> {
  const zipPath = join(tempDir, `${kind}.zip`);
  await buildMaliciousZip(kind, zipPath);
  const buf = await readFile(zipPath);
  await expect(extractZip(buf, destDir, limits(limitOverrides))).rejects.toThrow(error);
}

function buildZip(entries: Array<{ path: string; contents: string }>): Promise<Buffer> {
  return new Promise((resolveBuf, rejectBuf) => {
    const zip = new yazl.ZipFile();
    for (const entry of entries) {
      zip.addBuffer(Buffer.from(entry.contents), entry.path);
    }
    zip.end();

    const chunks: Buffer[] = [];
    zip.outputStream.on('data', (chunk: Buffer) => chunks.push(chunk));
    zip.outputStream.on('end', () => resolveBuf(Buffer.concat(chunks)));
    zip.outputStream.on('error', rejectBuf);
  });
}

function replaceBytes(buf: Buffer, from: string, to: string): Buffer {
  if (Buffer.byteLength(from) !== Buffer.byteLength(to)) {
    throw new Error('byte-length replacement required to keep zip offsets valid');
  }
  const fromBuf = Buffer.from(from);
  const toBuf = Buffer.from(to);
  let out = buf;
  let offset = out.indexOf(fromBuf);
  while (offset !== -1) {
    out = Buffer.concat([out.subarray(0, offset), toBuf, out.subarray(offset + fromBuf.length)]);
    offset = out.indexOf(fromBuf, offset + toBuf.length);
  }
  return out;
}

function limits(overrides: Partial<ExtractLimits>): ExtractLimits {
  return {
    ...LIMITS,
    ...overrides,
  };
}
