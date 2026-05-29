import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InstalledSkill, SkillDetail, SkillSummary } from '@asr/core';

vi.mock('./config.js', () => ({
  getConfig: vi.fn(() => ({ defaultTarget: 'project' as const })),
  getConfigWithSecrets: vi.fn(async () => ({ defaultTarget: 'project' as const })),
}));

vi.mock('./registry-client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./registry-client.js')>();
  return {
    ...actual,
    searchSkills: vi.fn(),
    getSkillDetail: vi.fn(),
  };
});

vi.mock('./lockfile.js', () => ({
  getAllInstalled: vi.fn(),
}));

vi.mock('./auth/registry-token.js', () => ({
  resolveRegistryToken: vi.fn(async () => undefined),
}));

vi.mock('ora', () => ({
  default: () => ({
    start: () => ({
      stop: () => undefined,
      fail: () => undefined,
      text: '',
    }),
  }),
}));

import { getSkillDetail, searchSkills, RegistryError } from './registry-client.js';
import { getAllInstalled } from './lockfile.js';
import { resolveRegistryToken } from './auth/registry-token.js';
import { registerSearch } from './commands/search.js';
import { registerInfo } from './commands/info.js';
import { registerVersions, runVersions } from './commands/versions.js';
import { registerList } from './commands/list.js';

const searchMock = vi.mocked(searchSkills);
const getSkillDetailMock = vi.mocked(getSkillDetail);
const getAllInstalledMock = vi.mocked(getAllInstalled);
const resolveRegistryTokenMock = vi.mocked(resolveRegistryToken);

function testProgram(): Command {
  const program = new Command();
  program.name('asr');
  program.exitOverride();
  registerSearch(program);
  return program;
}

describe('search command', () => {
  let log: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    searchMock.mockReset();
    resolveRegistryTokenMock.mockReset();
    resolveRegistryTokenMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    log.mockRestore();
  });

  it('prints owner/name rows with latestVersion and downloadCount for each result', async () => {
    const items: SkillSummary[] = [
      {
        owner: 'acme',
        name: 'code-review',
        latestVersion: '1.0.0',
        description: 'Reviews code',
        tags: ['security'],
        kind: 'skill',
        publishedAt: '2026-05-23T10:00:00Z',
        downloadCount: 42,
        riskAssessmentLatest: 'low',
      },
      {
        owner: 'beta',
        name: 'docs-writer',
        latestVersion: '2.3.1',
        description: 'Writes docs',
        tags: [],
        kind: 'skill',
        publishedAt: '2026-05-24T10:00:00Z',
        downloadCount: 7,
        riskAssessmentLatest: 'low',
      },
    ];
    searchMock.mockResolvedValueOnce({ items });

    const program = testProgram();
    await program.parseAsync(['node', 'asr', 'search', 'foo']);

    expect(searchMock).toHaveBeenCalledWith('foo', {}, {});

    const printed = log.mock.calls.map((args: unknown[]) => String(args[0])).join('\n');
    expect(printed).toContain('acme/code-review');
    expect(printed).toContain('v1.0.0');
    expect(printed).toContain('downloads 42');
    expect(printed).toContain('beta/docs-writer');
    expect(printed).toContain('v2.3.1');
    expect(printed).toContain('downloads 7');
  });

  it('passes the resolved registry token when available', async () => {
    searchMock.mockResolvedValueOnce({ items: [] });
    resolveRegistryTokenMock.mockResolvedValueOnce('cached-token');

    const program = testProgram();
    await program.parseAsync(['node', 'asr', 'search', 'foo']);

    expect(resolveRegistryTokenMock).toHaveBeenCalledWith({ configToken: undefined });
    expect(searchMock).toHaveBeenCalledWith('foo', {}, { token: 'cached-token' });
  });

  it('prints "No skills found." when items is empty', async () => {
    searchMock.mockResolvedValueOnce({ items: [] });

    const program = testProgram();
    await program.parseAsync(['node', 'asr', 'search', 'nothing']);

    const printed = log.mock.calls.map((args: unknown[]) => String(args[0])).join('\n');
    expect(printed).toContain('No skills found.');
  });
});

function infoProgram(): Command {
  const program = new Command();
  program.name('asr');
  program.exitOverride();
  registerInfo(program);
  return program;
}

describe('info command', () => {
  let log: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    getSkillDetailMock.mockReset();
    resolveRegistryTokenMock.mockReset();
    resolveRegistryTokenMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    log.mockRestore();
  });

  it('prints latestVersion, description, and riskAssessmentLatest for the requested skill', async () => {
    const detail: SkillDetail = {
      owner: 'owner',
      name: 'code-review',
      latestVersion: '1.2.3',
      description: 'Reviews code with security focus',
      tags: ['security', 'review'],
      kind: 'skill',
      publishedAt: '2026-05-23T10:00:00Z',
      downloadCount: 99,
      riskAssessmentLatest: 'medium',
      manifestLatest: {
        name: 'code-review',
        version: '1.2.3',
        author: 'owner',
        description: 'Reviews code with security focus',
        tags: ['security', 'review'],
        kind: 'skill',
        permissions: {
          network: false,
          filesystem: 'none',
          subprocess: false,
          environment: [],
        },
      },
      versions: [],
    };
    getSkillDetailMock.mockResolvedValueOnce(detail);

    const program = infoProgram();
    await program.parseAsync(['node', 'asr', 'info', 'owner/code-review']);

    expect(getSkillDetailMock).toHaveBeenCalledWith('owner', 'code-review', {});

    const printed = log.mock.calls.map((args: unknown[]) => String(args[0])).join('\n');
    expect(printed).toContain('v1.2.3');
    expect(printed).toContain('Reviews code with security focus');
    expect(printed).toContain('medium');
  });

  it('passes the resolved registry token when available', async () => {
    const detail: SkillDetail = {
      owner: 'owner',
      name: 'code-review',
      latestVersion: '1.2.3',
      description: 'Reviews code',
      tags: [],
      kind: 'skill',
      publishedAt: '2026-05-23T10:00:00Z',
      downloadCount: 0,
      riskAssessmentLatest: 'low',
      manifestLatest: {
        name: 'code-review',
        version: '1.2.3',
        author: 'owner',
        description: 'Reviews code',
        tags: [],
        kind: 'skill',
        permissions: {
          network: false,
          filesystem: 'none',
          subprocess: false,
          environment: [],
        },
      },
      versions: [],
    };
    getSkillDetailMock.mockResolvedValueOnce(detail);
    resolveRegistryTokenMock.mockResolvedValueOnce('cached-token');

    const program = infoProgram();
    await program.parseAsync(['node', 'asr', 'info', 'owner/code-review']);

    expect(getSkillDetailMock).toHaveBeenCalledWith('owner', 'code-review', {
      token: 'cached-token',
    });
  });
});

function versionsProgram(): Command {
  const program = new Command();
  program.name('asr');
  program.exitOverride();
  registerVersions(program);
  return program;
}

describe('versions command', () => {
  let log: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    getSkillDetailMock.mockReset();
    resolveRegistryTokenMock.mockReset();
    resolveRegistryTokenMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    log.mockRestore();
  });

  it('marks yanked versions and tags the latest non-yanked version', async () => {
    const detail: SkillDetail = {
      owner: 'owner',
      name: 'code-review',
      latestVersion: '1.2.0',
      description: 'Reviews code',
      tags: [],
      kind: 'skill',
      publishedAt: '2026-05-23T10:00:00Z',
      downloadCount: 0,
      riskAssessmentLatest: 'low',
      manifestLatest: {
        name: 'code-review',
        version: '1.2.0',
        author: 'owner',
        description: 'Reviews code',
        tags: [],
        kind: 'skill',
        permissions: {
          network: false,
          filesystem: 'none',
          subprocess: false,
          environment: [],
        },
      },
      versions: [
        {
          owner: 'owner',
          name: 'code-review',
          version: '1.0.0',
          contentHash: 'sha256:a',
          publishedAt: '2026-05-20T10:00:00Z',
          publishedBy: 'owner',
          approvedBy: 'admin',
          prNumber: 1,
          mergeCommit: 'aaa',
          yanked: false,
          riskAssessment: 'low',
        },
        {
          owner: 'owner',
          name: 'code-review',
          version: '1.1.0',
          contentHash: 'sha256:b',
          publishedAt: '2026-05-21T10:00:00Z',
          publishedBy: 'owner',
          approvedBy: 'admin',
          prNumber: 2,
          mergeCommit: 'bbb',
          yanked: true,
          yankedAt: '2026-05-22T00:00:00Z',
          yankReason: 'security issue',
          riskAssessment: 'low',
        },
        {
          owner: 'owner',
          name: 'code-review',
          version: '1.2.0',
          contentHash: 'sha256:c',
          publishedAt: '2026-05-23T10:00:00Z',
          publishedBy: 'owner',
          approvedBy: 'admin',
          prNumber: 3,
          mergeCommit: 'ccc',
          yanked: false,
          riskAssessment: 'low',
        },
      ],
    };
    getSkillDetailMock.mockResolvedValueOnce(detail);

    const program = versionsProgram();
    await program.parseAsync(['node', 'asr', 'versions', 'owner/code-review']);

    expect(getSkillDetailMock).toHaveBeenCalledWith('owner', 'code-review', {});

    const lines: string[] = log.mock.calls.map((args: unknown[]) => String(args[0]));
    const printed = lines.join('\n');

    expect(printed).toContain('1.1.0');
    expect(printed).toContain('yanked: security issue');
    expect(printed).toContain('1.2.0');
    expect(printed).toContain('<- latest');

    const latestLine = lines.find((l) => l.includes('1.2.0'));
    expect(latestLine).toBeDefined();
    expect(latestLine).toContain('<- latest');
    expect(latestLine).not.toContain('yanked:');

    const yankedLine = lines.find((l) => l.includes('1.1.0'));
    expect(yankedLine).toBeDefined();
    expect(yankedLine).toContain('yanked: security issue');
    expect(yankedLine).not.toContain('<- latest');

    const firstLine = lines[0];
    expect(firstLine).toContain('1.2.0');
    const lastLine = lines[lines.length - 1];
    expect(lastLine).toContain('1.0.0');
  });

  it('returns a non-zero exit code and surfaces "skill not found" when the registry 404s', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    getSkillDetailMock.mockRejectedValueOnce(new RegistryError(404, 'not found'));

    const code = await runVersions('owner/missing');

    expect(code).toBe(1);
    const errPrinted = errSpy.mock.calls.map((args: unknown[]) => String(args[0])).join('\n');
    expect(errPrinted).toContain('skill not found');
    expect(errPrinted).toContain('owner/missing');

    errSpy.mockRestore();
  });

  it('passes the resolved registry token when available', async () => {
    const detail: SkillDetail = {
      owner: 'owner',
      name: 'code-review',
      latestVersion: '1.0.0',
      description: 'Reviews code',
      tags: [],
      kind: 'skill',
      publishedAt: '2026-05-23T10:00:00Z',
      downloadCount: 0,
      riskAssessmentLatest: 'low',
      manifestLatest: {
        name: 'code-review',
        version: '1.0.0',
        author: 'owner',
        description: 'Reviews code',
        tags: [],
        kind: 'skill',
        permissions: {
          network: false,
          filesystem: 'none',
          subprocess: false,
          environment: [],
        },
      },
      versions: [],
    };
    getSkillDetailMock.mockResolvedValueOnce(detail);
    resolveRegistryTokenMock.mockResolvedValueOnce('cached-token');

    const code = await runVersions('owner/code-review');

    expect(code).toBe(0);
    expect(getSkillDetailMock).toHaveBeenCalledWith('owner', 'code-review', {
      token: 'cached-token',
    });
  });

  it('returns a non-zero exit code without calling the registry when the slug is malformed', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const code = await runVersions('not-a-slug');

    expect(code).toBe(1);
    expect(getSkillDetailMock).not.toHaveBeenCalled();
    const errPrinted = errSpy.mock.calls.map((args: unknown[]) => String(args[0])).join('\n');
    expect(errPrinted).toContain('Invalid slug');

    errSpy.mockRestore();
  });
});

function listProgram(): Command {
  const program = new Command();
  program.name('asr');
  program.exitOverride();
  registerList(program);
  return program;
}

describe('list command', () => {
  let log: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    getAllInstalledMock.mockReset();
  });

  afterEach(() => {
    log.mockRestore();
  });

  it('prints project and global installed skills with versions and scope tags', async () => {
    const projectEntries: Record<string, InstalledSkill> = {
      'project-skill': {
        name: 'project-skill',
        source: 'registry:acme/project-skill',
        version: '1.0.0',
        installedAt: '2026-05-22T10:00:00Z',
        updatedAt: '2026-05-22T10:00:00Z',
      },
    };
    const globalEntries: Record<string, InstalledSkill> = {
      'global-skill': {
        name: 'global-skill',
        source: 'registry:beta/global-skill',
        version: '2.3.1',
        installedAt: '2026-05-23T10:00:00Z',
        updatedAt: '2026-05-23T10:00:00Z',
        sourceUrl: 'https://reg.example/skills/beta/global-skill',
      },
    };

    getAllInstalledMock.mockImplementation(async (_target, global) =>
      global ? globalEntries : projectEntries,
    );

    const program = listProgram();
    await program.parseAsync(['node', 'asr', 'list']);

    const lines = log.mock.calls.map((args: unknown[]) => String(args[0]));
    const printed = lines.join('\n');

    expect(printed).toContain('project-skill');
    expect(printed).toContain('v1.0.0');
    expect(printed).toContain('[project]');
    expect(printed).toContain('registry:acme/project-skill');

    expect(printed).toContain('global-skill');
    expect(printed).toContain('v2.3.1');
    expect(printed).toContain('[global]');
    expect(printed).toContain('https://reg.example/skills/beta/global-skill');

    const projectLine = lines.find((l: string) => l.includes('project-skill'));
    expect(projectLine).toBeDefined();
    expect(projectLine).toContain('[project]');
    expect(projectLine).not.toContain('[global]');

    const globalLine = lines.find((l: string) => l.includes('global-skill'));
    expect(globalLine).toBeDefined();
    expect(globalLine).toContain('[global]');
    expect(globalLine).not.toContain('[project]');
  });

  it('prints "No skills installed." when both scopes are empty', async () => {
    getAllInstalledMock.mockResolvedValue({});

    const program = listProgram();
    await program.parseAsync(['node', 'asr', 'list']);

    const printed = log.mock.calls.map((args: unknown[]) => String(args[0])).join('\n');
    expect(printed).toContain('No skills installed.');
  });
});
