import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { unzipSync, strFromU8 } from 'fflate';
import { packSkillDir } from '../publish/pack.js';

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'asr-cli-pack-'));
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

describe('packSkillDir', () => {
  it('returns a non-empty zip and lists relative paths for SKILL.md and scripts/run.py', async () => {
    const skillBody = '---\nname: demo\nversion: 1.0.0\n---\n# Demo skill\n';
    const scriptBody = '#!/usr/bin/env python3\nprint("hello")\n';
    await writeFile(join(workDir, 'SKILL.md'), skillBody);
    await mkdir(join(workDir, 'scripts'), { recursive: true });
    await writeFile(join(workDir, 'scripts', 'run.py'), scriptBody);

    const { buffer, files } = await packSkillDir(workDir);

    expect(buffer.length).toBeGreaterThan(0);
    expect(files.sort()).toEqual(['SKILL.md', 'scripts/run.py']);

    const unzipped = unzipSync(new Uint8Array(buffer));
    expect(Object.keys(unzipped).sort()).toEqual(['SKILL.md', 'scripts/run.py']);
    expect(strFromU8(unzipped['SKILL.md']!)).toBe(skillBody);
    expect(strFromU8(unzipped['scripts/run.py']!)).toBe(scriptBody);
  });

  it('skips node_modules and .git when walking the source directory', async () => {
    await writeFile(join(workDir, 'SKILL.md'), '# keep me\n');
    await mkdir(join(workDir, 'node_modules', 'pkg'), { recursive: true });
    await writeFile(join(workDir, 'node_modules', 'pkg', 'index.js'), 'module.exports = 1;');
    await mkdir(join(workDir, '.git'), { recursive: true });
    await writeFile(join(workDir, '.git', 'HEAD'), 'ref: refs/heads/main');

    const { files } = await packSkillDir(workDir);

    expect(files).toEqual(['SKILL.md']);
  });

  it('produces a deterministic byte stream for the same input tree', async () => {
    await writeFile(join(workDir, 'SKILL.md'), '# determinism\n');
    await mkdir(join(workDir, 'docs'), { recursive: true });
    await writeFile(join(workDir, 'docs', 'a.txt'), 'one');
    await writeFile(join(workDir, 'docs', 'b.txt'), 'two');

    const first = await packSkillDir(workDir);
    const second = await packSkillDir(workDir);

    expect(first.buffer.equals(second.buffer)).toBe(true);
    expect(first.files).toEqual(second.files);
  });
});
