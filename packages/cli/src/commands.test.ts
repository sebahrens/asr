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
