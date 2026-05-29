import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const getSkillDetail = vi.fn();
const resolveDownload = vi.fn();
const downloadAndVerify = vi.fn();
const extractZip = vi.fn();
const readBundleContents = vi.fn();

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

vi.mock('./bundle.js', () => ({
  readBundleContents: (...args: unknown[]) => readBundleContents(...args),
}));

const { installSkill, removeSkill, resolveInstallTarget, updateSkill } = await import(
  './install.js'
);

function emptyBundle() {
  return { root: null, references: new Map() };
}

function personaBundle(overrides: {
  persona_mode?: 'inject' | 'delegate';
  references?: string[];
  body?: string;
  bundledRefs?: Record<string, { references?: string[]; body?: string }>;
} = {}) {
  const refs = new Map();
  for (const [name, info] of Object.entries(overrides.bundledRefs ?? {})) {
    refs.set(name, {
      manifest: {
        name,
        version: '1.0.0',
        author: 'a',
        description: `${name} desc`,
        tags: [],
        kind: 'skill',
        references: info.references,
        permissions: {
          network: false,
          filesystem: 'none',
          subprocess: false,
          environment: [],
        },
      },
      body: info.body ?? `# ${name}`,
    });
  }
  return {
    root: {
      manifest: {
        name: 'demo',
        version: '1.2.3',
        author: 'finance',
        description: 'demo persona',
        tags: [],
        kind: 'persona' as const,
        persona_mode: overrides.persona_mode ?? 'inject',
        references: overrides.references,
        permissions: {
          network: false,
          filesystem: 'read-write-own' as const,
          subprocess: true,
          environment: [],
        },
      },
      body: overrides.body ?? 'You are a demo persona.',
    },
    references: refs,
  };
}

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
    readBundleContents.mockReset();
    readBundleContents.mockResolvedValue(emptyBundle());
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

    expect(downloadAndVerify).toHaveBeenCalledWith(DOWNLOAD_URL, HASH);
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
    await expect(installSkill('owner/..')).rejects.toThrow(/Invalid slug/);
    await expect(installSkill('owner/.')).rejects.toThrow(/Invalid slug/);
    await expect(installSkill('owner/demo@..')).rejects.toThrow(/Invalid slug/);
    await expect(installSkill('own\ner/demo')).rejects.toThrow(/Invalid slug/);
    expect(getSkillDetail).not.toHaveBeenCalled();
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

  it('refuses to install when detail.versions entry is yanked (without yankReason)', async () => {
    const d = detail();
    (d as { versions: Array<{ version: string; yanked: boolean }> }).versions[0].yanked = true;
    getSkillDetail.mockResolvedValueOnce(d);

    await expect(installSkill('acme/demo@1.2.3')).rejects.toThrow(
      /Refusing to install acme\/demo@1\.2\.3: version is yanked/,
    );
    expect(resolveDownload).not.toHaveBeenCalled();
    expect(downloadAndVerify).not.toHaveBeenCalled();
    expect(extractZip).not.toHaveBeenCalled();
    await expect(readFile(join(tempDir, '.agent', 'asr.lock.json'), 'utf-8')).rejects.toThrow();
  });

  it('refuses to install when detail.versions entry is yanked and includes yankReason in the message', async () => {
    const d = detail();
    const v0 = (d as { versions: Array<{ version: string; yanked: boolean; yankReason?: string }> })
      .versions[0];
    v0.yanked = true;
    v0.yankReason = 'CVE-2026-0001';
    getSkillDetail.mockResolvedValueOnce(d);

    await expect(installSkill('acme/demo@1.2.3')).rejects.toThrow(/CVE-2026-0001/);
    expect(resolveDownload).not.toHaveBeenCalled();
    expect(downloadAndVerify).not.toHaveBeenCalled();
  });

  it('refuses to install when resolveDownload reports yanked even if detail entry is stale', async () => {
    getSkillDetail.mockResolvedValueOnce(detail());
    resolveDownload.mockResolvedValueOnce({ url: DOWNLOAD_URL, yanked: true });

    await expect(installSkill('acme/demo')).rejects.toThrow(
      /Refusing to install acme\/demo@1\.2\.3: version is yanked/,
    );
    expect(downloadAndVerify).not.toHaveBeenCalled();
    expect(extractZip).not.toHaveBeenCalled();
    await expect(readFile(join(tempDir, '.agent', 'asr.lock.json'), 'utf-8')).rejects.toThrow();
  });

  it('uses Bearer token for registry API calls but not artifact downloads', async () => {
    getSkillDetail.mockResolvedValueOnce(detail());
    resolveDownload.mockResolvedValueOnce({ url: DOWNLOAD_URL, yanked: false });
    downloadAndVerify.mockResolvedValueOnce(ZIP_BUF);

    await installSkill('acme/demo', { token: 't0k' });

    expect(getSkillDetail).toHaveBeenCalledWith('acme', 'demo', { token: 't0k' });
    expect(resolveDownload).toHaveBeenCalledWith('acme', 'demo', '1.2.3', { token: 't0k' });
    expect(downloadAndVerify).toHaveBeenCalledWith(DOWNLOAD_URL, HASH);
  });

  it('writes a generated SKILL.md with when_to_use: always for an inject persona', async () => {
    getSkillDetail.mockResolvedValueOnce(detail({ kind: 'persona' }));
    resolveDownload.mockResolvedValueOnce({ url: DOWNLOAD_URL, yanked: false });
    downloadAndVerify.mockResolvedValueOnce(ZIP_BUF);
    readBundleContents.mockResolvedValueOnce(
      personaBundle({ persona_mode: 'inject', body: 'You are a demo persona.' }),
    );

    await installSkill('acme/demo');

    const skillMd = await readFile(
      join(tempDir, '.claude', 'skills', 'demo', 'SKILL.md'),
      'utf-8',
    );
    expect(skillMd).toMatch(/when_to_use:\s*always/);
    expect(skillMd).toContain('You are a demo persona.');
  });

  it('writes a generated SKILL.md with allowed-tools including Agent for a delegate persona', async () => {
    getSkillDetail.mockResolvedValueOnce(detail({ kind: 'persona' }));
    resolveDownload.mockResolvedValueOnce({ url: DOWNLOAD_URL, yanked: false });
    downloadAndVerify.mockResolvedValueOnce(ZIP_BUF);
    readBundleContents.mockResolvedValueOnce(
      personaBundle({
        persona_mode: 'delegate',
        references: ['code-review'],
        bundledRefs: { 'code-review': { body: 'Reviews code.' } },
      }),
    );

    await installSkill('acme/demo');

    const skillMd = await readFile(
      join(tempDir, '.claude', 'skills', 'demo', 'SKILL.md'),
      'utf-8',
    );
    const frontmatter = skillMd.split('---')[1] ?? '';
    const tools = frontmatter.match(/allowed-tools:\s*(.+)/)?.[1] ?? '';
    expect(tools).toContain('Agent');
    expect(skillMd).toContain('### code-review');
    expect(skillMd).toContain('Reviews code.');
  });

  it('rejects a persona with a reference cycle as invalid_manifest and writes no files', async () => {
    getSkillDetail.mockResolvedValueOnce(detail({ kind: 'persona' }));
    resolveDownload.mockResolvedValueOnce({ url: DOWNLOAD_URL, yanked: false });
    downloadAndVerify.mockResolvedValueOnce(ZIP_BUF);
    readBundleContents.mockResolvedValueOnce(
      personaBundle({ persona_mode: 'delegate', references: ['demo'] }),
    );

    let caught: unknown;
    try {
      await installSkill('acme/demo');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
    expect((caught as { code?: string }).code).toBe('invalid_manifest');
    expect((caught as Error).message).toMatch(/cycle/);
    expect(extractZip).not.toHaveBeenCalled();
    await expect(
      readFile(join(tempDir, '.claude', 'skills', 'demo', 'SKILL.md'), 'utf-8'),
    ).rejects.toThrow();
    await expect(
      readFile(join(tempDir, '.agent', 'asr.lock.json'), 'utf-8'),
    ).rejects.toThrow();
  });

  it('keeps verbatim copy for kind:skill (no persona overlay)', async () => {
    getSkillDetail.mockResolvedValueOnce(detail());
    resolveDownload.mockResolvedValueOnce({ url: DOWNLOAD_URL, yanked: false });
    downloadAndVerify.mockResolvedValueOnce(ZIP_BUF);
    readBundleContents.mockResolvedValueOnce({
      root: {
        manifest: {
          name: 'demo',
          version: '1.2.3',
          author: 'a',
          description: 'demo skill',
          tags: [],
          kind: 'skill' as const,
          permissions: {
            network: false,
            filesystem: 'none' as const,
            subprocess: false,
            environment: [],
          },
        },
        body: '# verbatim body',
      },
      references: new Map(),
    });

    await installSkill('acme/demo');

    expect(extractZip).toHaveBeenCalledTimes(1);
    await expect(
      readFile(join(tempDir, '.claude', 'skills', 'demo', 'SKILL.md'), 'utf-8'),
    ).rejects.toThrow();
  });
});

describe('resolveInstallTarget', () => {
  function makeDetail(overrides: Record<string, unknown> = {}): unknown {
    return {
      owner: 'acme',
      name: 'x',
      latestVersion: '1.1.0',
      description: 'x',
      tags: [],
      kind: 'skill',
      publishedAt: '2026-05-23T10:00:00Z',
      downloadCount: 0,
      riskAssessmentLatest: 'low',
      manifestLatest: {},
      versions: [
        { version: '1.0.0', yanked: false },
        { version: '1.1.0', yanked: false },
        { version: '0.9.0', yanked: true, yankReason: 'leak' },
      ],
      ...overrides,
    };
  }

  it('refuses an explicit yanked version with a reason matching /yanked/', async () => {
    const fetchRegistry = vi.fn(async () => makeDetail()) as never;
    const result = await resolveInstallTarget({ fetchRegistry }, 'acme', 'x', '0.9.0');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/yanked/);
      expect(result.reason).toContain('leak');
    }
  });

  it('returns ok with latestVersion when no version is given', async () => {
    const fetchRegistry = vi.fn(async () => makeDetail()) as never;
    const result = await resolveInstallTarget({ fetchRegistry }, 'acme', 'x');
    expect(result).toEqual({ ok: true, version: '1.1.0' });
  });

  it('returns ok with the requested non-yanked version', async () => {
    const fetchRegistry = vi.fn(async () => makeDetail()) as never;
    const result = await resolveInstallTarget({ fetchRegistry }, 'acme', 'x', '1.0.0');
    expect(result).toEqual({ ok: true, version: '1.0.0' });
  });

  it('returns ok:false when explicit version is not found in detail.versions', async () => {
    const fetchRegistry = vi.fn(async () => makeDetail()) as never;
    const result = await resolveInstallTarget({ fetchRegistry }, 'acme', 'x', '9.9.9');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/9\.9\.9 not found/);
  });

  it('falls back to "withdrawn" when yankReason is absent', async () => {
    const detail = makeDetail({
      versions: [{ version: '0.9.0', yanked: true }],
    });
    const fetchRegistry = vi.fn(async () => detail) as never;
    const result = await resolveInstallTarget({ fetchRegistry }, 'acme', 'x', '0.9.0');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('withdrawn');
  });

  it('returns ok:false when latestVersion is empty and no version is given', async () => {
    const fetchRegistry = vi.fn(async () => makeDetail({ latestVersion: '' })) as never;
    const result = await resolveInstallTarget({ fetchRegistry }, 'acme', 'x');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/no non-yanked version/);
  });
});

describe('updateSkill', () => {
  let tempDir: string;
  let cwdSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;

  async function seedLockfile(skills: Record<string, { source: string; version?: string }>) {
    const agentDir = join(tempDir, '.agent');
    await mkdir(agentDir, { recursive: true });
    const now = '2026-05-23T10:00:00Z';
    const lock = {
      version: 1,
      skills: Object.fromEntries(
        Object.entries(skills).map(([name, info]) => [
          name,
          {
            name,
            source: info.source,
            version: info.version,
            installedAt: now,
            updatedAt: now,
          },
        ]),
      ),
    };
    await writeFile(join(agentDir, 'asr.lock.json'), JSON.stringify(lock, null, 2));
  }

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'asr-update-'));
    await mkdir(join(tempDir, '.claude'), { recursive: true });
    cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tempDir);
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    getSkillDetail.mockReset();
    resolveDownload.mockReset();
    downloadAndVerify.mockReset();
    extractZip.mockReset();
    extractZip.mockResolvedValue(['SKILL.md']);
    readBundleContents.mockReset();
    readBundleContents.mockResolvedValue(emptyBundle());
  });

  afterEach(async () => {
    cwdSpy.mockRestore();
    logSpy.mockRestore();
    await rm(tempDir, { recursive: true, force: true });
  });

  it('reinstalls latest non-yanked and prints "owner/name: old -> new"', async () => {
    await seedLockfile({ demo: { source: 'registry:acme/demo', version: '1.0.0' } });

    getSkillDetail.mockResolvedValueOnce(detail());
    getSkillDetail.mockResolvedValueOnce(detail());
    resolveDownload.mockResolvedValueOnce({ url: DOWNLOAD_URL, yanked: false });
    downloadAndVerify.mockResolvedValueOnce(ZIP_BUF);

    const results = await updateSkill('acme/demo');

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      owner: 'acme',
      name: 'demo',
      oldVersion: '1.0.0',
      newVersion: '1.2.3',
      upToDate: false,
    });
    expect(logSpy).toHaveBeenCalledWith('acme/demo: 1.0.0 -> 1.2.3');
    expect(downloadAndVerify).toHaveBeenCalledTimes(1);

    const lock = JSON.parse(
      await readFile(join(tempDir, '.agent', 'asr.lock.json'), 'utf-8'),
    );
    expect(lock.skills['demo'].version).toBe('1.2.3');
  });

  it('prints "up to date" and skips reinstall when already at latest', async () => {
    await seedLockfile({ demo: { source: 'registry:acme/demo', version: '1.2.3' } });

    getSkillDetail.mockResolvedValueOnce(detail());

    const results = await updateSkill('acme/demo');

    expect(results[0]).toMatchObject({
      oldVersion: '1.2.3',
      newVersion: '1.2.3',
      upToDate: true,
    });
    expect(logSpy).toHaveBeenCalledWith('acme/demo: up to date');
    expect(resolveDownload).not.toHaveBeenCalled();
    expect(downloadAndVerify).not.toHaveBeenCalled();
    expect(extractZip).not.toHaveBeenCalled();
  });

  it('iterates every registry-sourced lockfile entry when no slug is given', async () => {
    await seedLockfile({
      demo: { source: 'registry:acme/demo', version: '1.0.0' },
      other: { source: 'registry:acme/other', version: '2.0.0' },
      'gh-only': { source: 'github:foo/bar/qux', version: '0.1.0' },
    });

    getSkillDetail.mockImplementation(async (owner: string, name: string) => {
      if (name === 'demo') return detail();
      return detail({
        owner,
        name,
        latestVersion: '2.0.0',
        versions: [
          {
            owner,
            name,
            version: '2.0.0',
            contentHash: 'sha256:other',
            publishedAt: '2026-05-01T00:00:00Z',
            publishedBy: 'u',
            approvedBy: null,
            prNumber: 2,
            mergeCommit: 'm',
            yanked: false,
            riskAssessment: 'low',
          },
        ],
      });
    });
    resolveDownload.mockResolvedValueOnce({ url: DOWNLOAD_URL, yanked: false });
    downloadAndVerify.mockResolvedValueOnce(ZIP_BUF);

    const results = await updateSkill();

    expect(results.map((r) => r.name)).toEqual(['demo', 'other']);
    expect(results[0].upToDate).toBe(false);
    expect(results[1].upToDate).toBe(true);
    expect(logSpy).toHaveBeenCalledWith('acme/demo: 1.0.0 -> 1.2.3');
    expect(logSpy).toHaveBeenCalledWith('acme/other: up to date');
  });

  it('throws when the named skill is not in the lockfile', async () => {
    await seedLockfile({ demo: { source: 'registry:acme/demo', version: '1.0.0' } });

    await expect(updateSkill('acme/missing')).rejects.toThrow(
      /acme\/missing is not installed from the registry/,
    );
  });

  it('throws when the named skill was installed from a non-registry source', async () => {
    await seedLockfile({ demo: { source: 'github:foo/bar/demo', version: '1.0.0' } });

    await expect(updateSkill('acme/demo')).rejects.toThrow(
      /acme\/demo is not installed from the registry/,
    );
  });

  it('returns empty list when no registry-sourced skills are installed and no slug is given', async () => {
    await seedLockfile({ 'gh-only': { source: 'github:foo/bar/qux', version: '0.1.0' } });

    const results = await updateSkill();

    expect(results).toEqual([]);
    expect(getSkillDetail).not.toHaveBeenCalled();
  });

  it('propagates token to getSkillDetail when opts.token is set', async () => {
    await seedLockfile({ demo: { source: 'registry:acme/demo', version: '1.2.3' } });

    getSkillDetail.mockResolvedValueOnce(detail());

    await updateSkill('acme/demo', { token: 't0k' });

    expect(getSkillDetail).toHaveBeenCalledWith('acme', 'demo', { token: 't0k' });
  });
});

describe('removeSkill', () => {
  let tempDir: string;
  let cwdSpy: ReturnType<typeof vi.spyOn>;

  async function seedLockfile(skills: Record<string, { source: string; version?: string }>) {
    const agentDir = join(tempDir, '.agent');
    await mkdir(agentDir, { recursive: true });
    const now = '2026-05-23T10:00:00Z';
    const lock = {
      version: 1,
      skills: Object.fromEntries(
        Object.entries(skills).map(([name, info]) => [
          name,
          {
            name,
            source: info.source,
            version: info.version,
            installedAt: now,
            updatedAt: now,
          },
        ]),
      ),
    };
    await writeFile(join(agentDir, 'asr.lock.json'), JSON.stringify(lock, null, 2));
  }

  async function seedSkillDir(agent: 'claude' | 'codex', name: string) {
    const dir = join(tempDir, `.${agent}`, 'skills', name);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'SKILL.md'), '# test\n');
  }

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'asr-remove-'));
    await mkdir(join(tempDir, '.claude'), { recursive: true });
    cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tempDir);
  });

  afterEach(async () => {
    cwdSpy.mockRestore();
    await rm(tempDir, { recursive: true, force: true });
  });

  it('deletes the .claude/skills/<name> dir and removes the lockfile entry', async () => {
    await seedSkillDir('claude', 'demo');
    await seedLockfile({ demo: { source: 'registry:acme/demo', version: '1.2.3' } });

    const result = await removeSkill('acme/demo');

    expect(result.owner).toBe('acme');
    expect(result.name).toBe('demo');
    expect(result.lockEntryRemoved).toBe(true);
    expect(result.locations).toEqual([
      { agent: 'claude', dir: join(tempDir, '.claude', 'skills', 'demo'), existed: true },
    ]);

    await expect(stat(join(tempDir, '.claude', 'skills', 'demo'))).rejects.toThrow();

    const lock = JSON.parse(
      await readFile(join(tempDir, '.agent', 'asr.lock.json'), 'utf-8'),
    );
    expect(lock.skills['demo']).toBeUndefined();
  });

  it('reports existed=false for every agent when nothing was installed and no lockfile entry exists', async () => {
    const result = await removeSkill('acme/demo');

    expect(result.lockEntryRemoved).toBe(false);
    expect(result.locations.every((l) => l.existed === false)).toBe(true);
  });

  it('removes from both .claude and .codex when both are present and agent=both', async () => {
    await mkdir(join(tempDir, '.codex'), { recursive: true });
    await seedSkillDir('claude', 'demo');
    await seedSkillDir('codex', 'demo');
    await seedLockfile({ demo: { source: 'registry:acme/demo', version: '1.2.3' } });

    const result = await removeSkill('acme/demo', { agent: 'both' });

    expect(result.locations.map((l) => l.agent)).toEqual(['claude', 'codex']);
    expect(result.locations.every((l) => l.existed)).toBe(true);
    expect(result.lockEntryRemoved).toBe(true);

    await expect(stat(join(tempDir, '.claude', 'skills', 'demo'))).rejects.toThrow();
    await expect(stat(join(tempDir, '.codex', 'skills', 'demo'))).rejects.toThrow();
  });

  it('targets only the explicit --agent when set to codex', async () => {
    await mkdir(join(tempDir, '.codex'), { recursive: true });
    await seedSkillDir('claude', 'demo');
    await seedSkillDir('codex', 'demo');

    const result = await removeSkill('acme/demo', { agent: 'codex' });

    expect(result.locations).toEqual([
      { agent: 'codex', dir: join(tempDir, '.codex', 'skills', 'demo'), existed: true },
    ]);

    await expect(stat(join(tempDir, '.codex', 'skills', 'demo'))).rejects.toThrow();
    await expect(stat(join(tempDir, '.claude', 'skills', 'demo'))).resolves.toBeDefined();
  });

  it('rejects invalid slugs without touching the filesystem', async () => {
    await seedSkillDir('claude', 'demo');
    await seedLockfile({ demo: { source: 'registry:acme/demo', version: '1.2.3' } });

    await expect(removeSkill('no-slash')).rejects.toThrow(/Invalid slug/);

    await expect(stat(join(tempDir, '.claude', 'skills', 'demo'))).resolves.toBeDefined();
    const lock = JSON.parse(
      await readFile(join(tempDir, '.agent', 'asr.lock.json'), 'utf-8'),
    );
    expect(lock.skills['demo']).toBeDefined();
  });

  it('removes the lockfile entry even when the agent dir was already gone', async () => {
    await seedLockfile({ demo: { source: 'registry:acme/demo', version: '1.2.3' } });

    const result = await removeSkill('acme/demo');

    expect(result.locations.every((l) => l.existed === false)).toBe(true);
    expect(result.lockEntryRemoved).toBe(true);

    const lock = JSON.parse(
      await readFile(join(tempDir, '.agent', 'asr.lock.json'), 'utf-8'),
    );
    expect(lock.skills['demo']).toBeUndefined();
  });
});
