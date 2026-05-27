import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const getSkillDetail = vi.fn();
const resolveDownload = vi.fn();
const downloadAndVerify = vi.fn();
const extractZip = vi.fn();

vi.mock('./registry-client.js', () => ({
  getSkillDetail: (...args: unknown[]) => getSkillDetail(...args),
  resolveDownload: (...args: unknown[]) => resolveDownload(...args),
}));

vi.mock('./download.js', () => ({
  downloadAndVerify: (...args: unknown[]) => downloadAndVerify(...args),
}));

vi.mock('./extract.js', () => ({
  extractZip: (...args: unknown[]) => extractZip(...args),
}));

const { installSkill } = await import('./install.js');

const DOWNLOAD_URL =
  'https://forgejo.internal/api/packages/acme/generic/demo/1.2.3/skill.zip';
const ZIP_BUF = Buffer.from('PK\x03\x04zip-payload');
const HASH = 'sha256:abcdef1234';

function detail(overrides: Record<string, unknown> = {}): unknown {
  return {
    owner: 'acme',
    name: 'demo',
    latestVersion: '1.2.3',
    description: 'demo skill',
    tags: [],
    kind: 'skill',
    publishedAt: '2026-05-23T10:00:00Z',
    downloadCount: 0,
    riskAssessmentLatest: 'low',
    manifestLatest: {},
    versions: [
      {
        owner: 'acme',
        name: 'demo',
        version: '1.2.3',
        contentHash: HASH,
        publishedAt: '2026-05-23T10:00:00Z',
        publishedBy: 'u',
        approvedBy: null,
        prNumber: 1,
        mergeCommit: 'abc',
        yanked: false,
        riskAssessment: 'low',
      },
      {
        owner: 'acme',
        name: 'demo',
        version: '1.0.0',
        contentHash: 'sha256:older',
        publishedAt: '2026-04-01T10:00:00Z',
        publishedBy: 'u',
        approvedBy: null,
        prNumber: 0,
        mergeCommit: 'old',
        yanked: false,
        riskAssessment: 'low',
      },
    ],
    ...overrides,
  };
}

describe('installSkill', () => {
  let tempDir: string;
  let cwdSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'asr-install-'));
    await mkdir(join(tempDir, '.claude'), { recursive: true });
    cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tempDir);
    getSkillDetail.mockReset();
    resolveDownload.mockReset();
    downloadAndVerify.mockReset();
    extractZip.mockReset();
    extractZip.mockResolvedValue(['SKILL.md']);
  });

  afterEach(async () => {
    cwdSpy.mockRestore();
    await rm(tempDir, { recursive: true, force: true });
  });

  it('writes files under detected scope and records contentHash in asr.lock.json', async () => {
    getSkillDetail.mockResolvedValueOnce(detail());
    resolveDownload.mockResolvedValueOnce({ url: DOWNLOAD_URL, yanked: false });
    downloadAndVerify.mockResolvedValueOnce(ZIP_BUF);

    const result = await installSkill('acme/demo');

    expect(result).toMatchObject({
      owner: 'acme',
      name: 'demo',
      version: '1.2.3',
      contentHash: HASH,
      sourceUrl: DOWNLOAD_URL,
      yanked: false,
    });
    expect(result.locations).toEqual([
      { agent: 'claude', dir: join(tempDir, '.claude', 'skills', 'demo'), files: ['SKILL.md'] },
    ]);

    expect(downloadAndVerify).toHaveBeenCalledWith(DOWNLOAD_URL, HASH, {});
    expect(extractZip).toHaveBeenCalledWith(
      ZIP_BUF,
      join(tempDir, '.claude', 'skills', 'demo'),
    );

    const lock = JSON.parse(
      await readFile(join(tempDir, '.agent', 'asr.lock.json'), 'utf-8'),
    );
    expect(lock.version).toBe(1);
    expect(lock.skills['demo']).toMatchObject({
      name: 'demo',
      source: 'registry:acme/demo',
      version: '1.2.3',
      contentHash: HASH,
      sourceUrl: DOWNLOAD_URL,
    });
  });

  it('parses @version from slug and resolves that version', async () => {
    getSkillDetail.mockResolvedValueOnce(detail());
    resolveDownload.mockResolvedValueOnce({
      url: DOWNLOAD_URL.replace('1.2.3', '1.0.0'),
      yanked: false,
    });
    downloadAndVerify.mockResolvedValueOnce(ZIP_BUF);

    const result = await installSkill('acme/demo@1.0.0');

    expect(result.version).toBe('1.0.0');
    expect(result.contentHash).toBe('sha256:older');
    expect(resolveDownload).toHaveBeenCalledWith('acme', 'demo', '1.0.0', {});
  });

  it('prefers opts.version over @version in slug', async () => {
    getSkillDetail.mockResolvedValueOnce(detail());
    resolveDownload.mockResolvedValueOnce({ url: DOWNLOAD_URL, yanked: false });
    downloadAndVerify.mockResolvedValueOnce(ZIP_BUF);

    await installSkill('acme/demo@1.0.0', { version: '1.2.3' });

    expect(resolveDownload).toHaveBeenCalledWith('acme', 'demo', '1.2.3', {});
  });

  it('falls back to detail.latestVersion when no version is supplied', async () => {
    getSkillDetail.mockResolvedValueOnce(detail());
    resolveDownload.mockResolvedValueOnce({ url: DOWNLOAD_URL, yanked: false });
    downloadAndVerify.mockResolvedValueOnce(ZIP_BUF);

    const result = await installSkill('acme/demo');

    expect(result.version).toBe('1.2.3');
  });

  it('throws when requested version is missing from detail.versions', async () => {
    getSkillDetail.mockResolvedValueOnce(detail());

    await expect(installSkill('acme/demo@9.9.9')).rejects.toThrow(/Version 9\.9\.9 not found/);
    expect(downloadAndVerify).not.toHaveBeenCalled();
  });

  it('rejects invalid slugs', async () => {
    await expect(installSkill('no-slash')).rejects.toThrow(/Invalid slug/);
    await expect(installSkill('a/')).rejects.toThrow(/Invalid slug/);
    await expect(installSkill('/b')).rejects.toThrow(/Invalid slug/);
    await expect(installSkill('a/b@')).rejects.toThrow(/Invalid slug/);
  });

  it('installs into every detected agent dir for explicit:both', async () => {
    getSkillDetail.mockResolvedValueOnce(detail());
    resolveDownload.mockResolvedValueOnce({ url: DOWNLOAD_URL, yanked: false });
    downloadAndVerify.mockResolvedValueOnce(ZIP_BUF);
    extractZip.mockResolvedValueOnce(['SKILL.md']);
    extractZip.mockResolvedValueOnce(['SKILL.md']);

    const result = await installSkill('acme/demo', { agent: 'both' });

    expect(result.locations.map((l) => l.agent)).toEqual(['claude', 'codex']);
    expect(extractZip).toHaveBeenCalledTimes(2);
    expect(extractZip).toHaveBeenNthCalledWith(
      1,
      ZIP_BUF,
      join(tempDir, '.claude', 'skills', 'demo'),
    );
    expect(extractZip).toHaveBeenNthCalledWith(
      2,
      ZIP_BUF,
      join(tempDir, '.codex', 'skills', 'demo'),
    );
  });

  it('only reads the yanked flag (does not refuse here)', async () => {
    getSkillDetail.mockResolvedValueOnce(detail());
    resolveDownload.mockResolvedValueOnce({ url: DOWNLOAD_URL, yanked: true });
    downloadAndVerify.mockResolvedValueOnce(ZIP_BUF);

    const result = await installSkill('acme/demo');

    expect(result.yanked).toBe(true);
    expect(downloadAndVerify).toHaveBeenCalled();
  });

  it('propagates Bearer token to all collaborators when opts.token is set', async () => {
    getSkillDetail.mockResolvedValueOnce(detail());
    resolveDownload.mockResolvedValueOnce({ url: DOWNLOAD_URL, yanked: false });
    downloadAndVerify.mockResolvedValueOnce(ZIP_BUF);

    await installSkill('acme/demo', { token: 't0k' });

    expect(getSkillDetail).toHaveBeenCalledWith('acme', 'demo', { token: 't0k' });
    expect(resolveDownload).toHaveBeenCalledWith('acme', 'demo', '1.2.3', { token: 't0k' });
    expect(downloadAndVerify).toHaveBeenCalledWith(DOWNLOAD_URL, HASH, { token: 't0k' });
  });
});
