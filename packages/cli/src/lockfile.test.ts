import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getAllInstalled, getLockFilePath, recordInstall, writeLockFile } from './lockfile.js';

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

  it('uses a scope-only lockfile regardless of legacy target argument', async () => {
    await recordInstall(
      'claude',
      false,
      'agent-skill',
      'registry:owner/agent-skill',
      '1.0.0',
    );

    await expect(readFile(join(tempDir, '.claude', 'asr.lock.json'), 'utf-8')).rejects.toThrow();
    await expect(readFile(join(tempDir, '.codex', 'asr.lock.json'), 'utf-8')).rejects.toThrow();

    expect(await getLockFilePath('project', false)).toBe(join(tempDir, '.agent', 'asr.lock.json'));
    expect(await getLockFilePath('claude', false)).toBe(join(tempDir, '.agent', 'asr.lock.json'));
    expect(await getAllInstalled('claude', false)).toMatchObject({
      'agent-skill': {
        name: 'agent-skill',
        source: 'registry:owner/agent-skill',
        version: '1.0.0',
      },
    });
  });

  it('preserves concurrent installs in the same lockfile', async () => {
    await Promise.all([
      recordInstall('project', false, 'alpha-skill', 'registry:owner/alpha-skill', '1.0.0'),
      recordInstall('project', false, 'beta-skill', 'registry:owner/beta-skill', '2.0.0'),
    ]);

    const installed = await getAllInstalled('project', false);

    expect(installed['alpha-skill']).toMatchObject({
      name: 'alpha-skill',
      source: 'registry:owner/alpha-skill',
      version: '1.0.0',
    });
    expect(installed['beta-skill']).toMatchObject({
      name: 'beta-skill',
      source: 'registry:owner/beta-skill',
      version: '2.0.0',
    });
  });

  it('refuses to overwrite a corrupt lockfile', async () => {
    const lockPath = join(tempDir, '.agent', 'asr.lock.json');
    const corruptJson = '{ "version": 1, "skills": {';
    await writeFile(lockPath, corruptJson, 'utf8');

    await expect(
      recordInstall('project', false, 'demo-skill', 'registry:owner/demo-skill'),
    ).rejects.toThrow(`Lockfile ${lockPath} contains invalid JSON; refusing to overwrite it.`);

    await expect(readFile(lockPath, 'utf8')).resolves.toBe(corruptJson);
  });

  it('writes through a temporary file and atomically renames into place', async () => {
    const lockPath = join(tempDir, '.agent', 'asr.lock.json');

    await writeLockFile(lockPath, {
      version: 1,
      skills: {
        demo: {
          name: 'demo',
          source: 'registry:owner/demo',
          installedAt: '2026-05-30T00:00:00.000Z',
          updatedAt: '2026-05-30T00:00:00.000Z',
        },
      },
    });

    const lock = JSON.parse(await readFile(lockPath, 'utf8'));
    const agentEntries = await readdir(join(tempDir, '.agent'));

    expect(lock.skills.demo.name).toBe('demo');
    expect(agentEntries).toEqual(['asr.lock.json']);
  });
});
