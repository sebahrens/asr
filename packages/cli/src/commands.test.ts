import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SkillDetail, SkillSummary } from '@asr/core';

vi.mock('./config.js', () => ({
  getConfig: vi.fn(() => ({ defaultTarget: 'project' as const })),
}));

vi.mock('./registry-client.js', () => ({
  searchSkills: vi.fn(),
  getSkillDetail: vi.fn(),
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

import { getSkillDetail, searchSkills } from './registry-client.js';
import { registerSearch } from './commands/search.js';
import { registerInfo } from './commands/info.js';
import { registerVersions } from './commands/versions.js';

const searchMock = vi.mocked(searchSkills);
const getSkillDetailMock = vi.mocked(getSkillDetail);

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

    const lines = log.mock.calls.map((args: unknown[]) => String(args[0]));
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
});
