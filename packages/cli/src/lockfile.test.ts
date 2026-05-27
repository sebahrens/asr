import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { recordInstall } from './lockfile.js';

let tempDir: string;
let cwdSpy: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'asr-cli-lockfile-'));
  await mkdir(join(tempDir, '.agent'), { recursive: true });
  cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tempDir);
});

afterEach(async () => {
  cwdSpy.mockRestore();
  await rm(tempDir, { recursive: true, force: true });
});

describe('recordInstall', () => {
  it('persists contentHash and sourceUrl into asr.lock.json entry', async () => {
    await recordInstall(
      'project',
      false,
      'demo-skill',
      'registry:owner/repo/demo-skill',
      '1.2.3',
      undefined,
      { contentHash: 'sha256:abc', sourceUrl: 'https://reg.example/skills/owner/demo-skill' },
    );

    const lockPath = join(tempDir, '.agent', 'asr.lock.json');
    const lock = JSON.parse(await readFile(lockPath, 'utf-8'));

    expect(lock.version).toBe(1);
    expect(lock.skills['demo-skill']).toMatchObject({
      name: 'demo-skill',
      source: 'registry:owner/repo/demo-skill',
      version: '1.2.3',
      contentHash: 'sha256:abc',
      sourceUrl: 'https://reg.example/skills/owner/demo-skill',
    });
  });

  it('still works without the options arg (legacy positional callers)', async () => {
    await recordInstall('project', false, 'plain-skill', 'github:owner/repo/plain-skill');

    const lockPath = join(tempDir, '.agent', 'asr.lock.json');
    const lock = JSON.parse(await readFile(lockPath, 'utf-8'));

    expect(lock.skills['plain-skill'].name).toBe('plain-skill');
    expect(lock.skills['plain-skill'].source).toBe('github:owner/repo/plain-skill');
    expect(lock.skills['plain-skill'].contentHash).toBeUndefined();
    expect(lock.skills['plain-skill'].sourceUrl).toBeUndefined();
  });
});
