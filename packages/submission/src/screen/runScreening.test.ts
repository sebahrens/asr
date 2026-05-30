import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ScreeningFinding, SkillManifest } from '@asr/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runScreening } from './runScreening.js';
import type { ScreeningProvider } from './providers/types.js';

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'asr-run-screening-'));
  await writeFixture('SKILL.md', '# Demo\nFormats files.\n');
  process.env.NODE_ENV = 'development';
  process.env.AUTH_MODE = 'mock';
  process.env.MOCK_USER_SUB = 'user_01';
  process.env.MOCK_USER_ROLES = 'Submitter';
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('runScreening', () => {
  it('returns skipped when no provider is configured', async () => {
    const report = await runScreening(baseInput(), () => null);

    expect(report).toMatchObject({
      submissionId: 'sub_01',
      contentHash: 'sha256:abc123',
      provider: 'none',
      model: 'none',
      contextTokens: 0,
      status: 'skipped',
      truncated: false,
      findings: [],
    });
  });

  it('does not require service env vars when the default provider is unconfigured', async () => {
    delete process.env.LLM_SCREEN_PROVIDER;
    delete process.env.NODE_ENV;
    delete process.env.AUTH_MODE;

    const report = await runScreening(baseInput());

    expect(report).toMatchObject({
      provider: 'none',
      model: 'none',
      status: 'skipped',
    });
  });

  it('returns clean when the provider reports no findings', async () => {
    const provider = fakeProvider([]);

    const report = await runScreening(baseInput(), () => provider);

    expect(report.status).toBe('clean');
    expect(report.findings).toEqual([]);
    expect(report).toMatchObject({
      provider: 'openai',
      model: 'gpt-test',
      contextTokens: 200000,
    });
    expect(provider.complete).toHaveBeenCalledOnce();
    expect(provider.complete).toHaveBeenCalledWith(
      expect.stringContaining('ScreeningFinding'),
      expect.stringContaining('# Screening input'),
    );
  });

  it('returns flagged when the provider reports findings', async () => {
    const finding: ScreeningFinding = {
      category: 'permission',
      severity: 'high',
      file: 'scripts/run.ts',
      line: 1,
      declared: 'network: false',
      observed: 'fetch("https://example.com")',
      message: 'Declared permissions do not match observed network use.',
    };

    const report = await runScreening(baseInput(), () => fakeProvider([finding]));

    expect(report.status).toBe('flagged');
    expect(report.findings).toEqual([finding]);
  });

  it('returns error when provider completion fails', async () => {
    const provider = fakeProvider([]);
    vi.mocked(provider.complete).mockRejectedValueOnce(new Error('provider unavailable'));

    const report = await runScreening(baseInput(), () => provider);

    expect(report).toMatchObject({
      provider: 'openai',
      model: 'gpt-test',
      status: 'error',
      truncated: false,
      findings: [],
    });
  });

  it('adds a truncation finding and flags md-only submissions when content is over budget', async () => {
    await writeFixture('large.txt', 'a'.repeat(500));
    const provider = fakeProvider([], 10);

    const report = await runScreening(
      baseInput({
        classification: 'md-only',
      }),
      () => provider,
    );

    expect(report.status).toBe('flagged');
    expect(report.truncated).toBe(true);
    expect(report.findings).toEqual([
      {
        category: 'description',
        severity: 'medium',
        message: 'LLM screening content exceeded the configured context budget and was truncated.',
      },
    ]);
  });
});

async function writeFixture(path: string, content: string): Promise<void> {
  const fullPath = join(tempDir, path);
  await mkdir(join(fullPath, '..'), { recursive: true });
  await writeFile(fullPath, content);
}

function fakeProvider(
  findings: ScreeningFinding[],
  contextTokens = 200000,
): ScreeningProvider {
  return {
    name: 'openai',
    model: 'gpt-test',
    contextTokens,
    complete: vi.fn(async () => findings),
  };
}

function baseInput(
  overrides: Partial<Parameters<typeof runScreening>[0]> = {},
): Parameters<typeof runScreening>[0] {
  return {
    submissionId: 'sub_01',
    contentHash: 'sha256:abc123',
    extractedDir: tempDir,
    manifest,
    classification: 'code-containing',
    ...overrides,
  };
}

const manifest: SkillManifest = {
  name: 'demo-skill',
  version: '1.0.0',
  author: 'team',
  description: 'Formats project files.',
  tags: ['formatting'],
  kind: 'skill',
  permissions: {
    network: false,
    filesystem: 'read-own',
    subprocess: false,
    environment: [],
  },
};
