import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PathTraversalError } from './extract.js';
import { InvalidFileMapError, parseFileMapResponse, writeValidatedFileMap } from './file-map.js';

let tempDir: string;
let targetDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'asr-cli-file-map-'));
  targetDir = join(tempDir, 'skill');
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe('parseFileMapResponse', () => {
  it('accepts files objects with string content', () => {
    expect(parseFileMapResponse({ files: { 'SKILL.md': '# Demo' } })).toEqual({
      'SKILL.md': '# Demo',
    });
  });

  it('rejects malformed file maps', () => {
    expect(() => parseFileMapResponse({ files: { 'SKILL.md': 1 } })).toThrow(
      InvalidFileMapError,
    );
    expect(() => parseFileMapResponse({ files: [] })).toThrow(InvalidFileMapError);
  });
});

describe('writeValidatedFileMap', () => {
  it('writes benign nested paths below targetDir', async () => {
    const written = await writeValidatedFileMap(targetDir, {
      'SKILL.md': '# Demo',
      'docs/readme.md': 'details',
    });

    expect(written.sort()).toEqual(['SKILL.md', 'docs/readme.md'].sort());
    await expect(readFile(join(targetDir, 'SKILL.md'), 'utf8')).resolves.toBe('# Demo');
    await expect(readFile(join(targetDir, 'docs', 'readme.md'), 'utf8')).resolves.toBe(
      'details',
    );
  });

  it('rejects ../ traversal and does not partially write safe entries', async () => {
    await expect(
      writeValidatedFileMap(targetDir, {
        'SKILL.md': '# Demo',
        '../evil.txt': 'owned',
      }),
    ).rejects.toBeInstanceOf(PathTraversalError);

    await expect(readFile(join(targetDir, 'SKILL.md'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(readFile(join(tempDir, 'evil.txt'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('rejects absolute paths', async () => {
    const absolutePath = isAbsolute('/tmp/evil.txt') ? '/tmp/evil.txt' : 'C:\\tmp\\evil.txt';

    await expect(
      writeValidatedFileMap(targetDir, {
        [absolutePath]: 'owned',
      }),
    ).rejects.toBeInstanceOf(PathTraversalError);
  });
});
