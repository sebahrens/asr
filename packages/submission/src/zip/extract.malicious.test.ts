import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildMaliciousZip, type MaliciousZipKind } from '../../test/fixtures/zip/buildMaliciousZips.js';
import { extractSafe, LIMITS, type ExtractLimits } from './extract.js';

let tempDir: string;
let zipPath: string;
let targetDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'asr-extract-malicious-'));
  zipPath = join(tempDir, 'fixture.zip');
  targetDir = join(tempDir, 'out');
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe('extractSafe malicious zip rejection suite', () => {
  it('rejects traversal fixture with path traversal', async () => {
    await expectRejects('pathTraversal', /path traversal/);
  });

  it('rejects excessive directory nesting fixture with max depth', async () => {
    await expectRejects('maxDepth', /max depth/);
  });

  it('rejects symlink fixture with symlink rejected', async () => {
    await expectRejects('symlink', /symlink rejected/);
  });

  it('rejects declared uncompressed-size overflow fixture with uncompressed size limit', async () => {
    await expectRejects('uncompressedSize', /uncompressed size limit/, { maxUncompressedBytes: 20 });
  });

  it('rejects streamed bytes when declared uncompressed size is lower than the actual payload', async () => {
    await expectRejects('misdeclaredUncompressedSize', /uncompressed size limit/, { maxUncompressedBytes: 128 });
  });

  it('unlinks partial files when streamed bytes breach the uncompressed size limit', async () => {
    await buildMaliciousZip('misdeclaredUncompressedSize', zipPath);

    await expect(extractSafe(zipPath, targetDir, limits({ maxUncompressedBytes: 128 }))).rejects.toThrow(
      /uncompressed size limit/,
    );
    await expect(access(join(targetDir, 'payload.txt'))).rejects.toThrow();
  });

  it('rejects excessive file-count fixture with max files', async () => {
    await expectRejects('maxFiles', /max files/, { maxFiles: 2 });
  });

  it('rejects excessive filename length fixture with path too long', async () => {
    await expectRejects('maxPathLen', /path too long/, { maxPathLen: 12 });
  });

  it('rejects control-char and RTL-override filename fixture with illegal chars', async () => {
    await expectRejects('illegalChars', /illegal chars/);
  });
});

async function expectRejects(
  kind: MaliciousZipKind,
  error: RegExp,
  limitOverrides: Partial<ExtractLimits> = {},
): Promise<void> {
  await buildMaliciousZip(kind, zipPath);
  await expect(extractSafe(zipPath, targetDir, limits(limitOverrides))).rejects.toThrow(error);
}

function limits(overrides: Partial<ExtractLimits>): ExtractLimits {
  return {
    ...LIMITS,
    ...overrides,
  };
}
