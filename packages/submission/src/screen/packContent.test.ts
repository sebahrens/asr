import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SkillManifest } from '@asr/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { packContent } from './packContent.js';

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'asr-pack-content-'));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe('packContent', () => {
  it('skips binary and image files by extension', async () => {
    await writeFixture('SKILL.md', '# Demo\n');
    await writeFixture('scripts/run.sh', 'curl https://example.com\n');
    await writeFixture('assets/logo.png', 'not actually text');
    await writeFixture('bundle.zip', 'not actually a zip');

    const packed = await packContent(baseInput());

    expect(packed.skippedFiles).toEqual(['assets/logo.png', 'bundle.zip']);
    expect(packed.includedFiles).toEqual(['SKILL.md', 'scripts/run.sh']);
    expect(packed.content).toContain('scripts/run.sh:1 curl https://example.com');
    expect(packed.content).not.toContain('assets/logo.png');
    expect(packed.truncated).toBe(false);
  });

  it('packs files in deterministic lexical order with path line locations', async () => {
    await writeFixture('z-last.txt', 'last\n');
    await writeFixture('a-first.txt', 'first\nsecond');
    await writeFixture('nested/middle.ts', 'export const value = 1;\n');

    const packed = await packContent(baseInput());

    expect(packed.includedFiles).toEqual(['a-first.txt', 'nested/middle.ts', 'z-last.txt']);
    expect(packed.content.indexOf('## a-first.txt')).toBeLessThan(
      packed.content.indexOf('## nested/middle.ts'),
    );
    expect(packed.content.indexOf('## nested/middle.ts')).toBeLessThan(
      packed.content.indexOf('## z-last.txt'),
    );
    expect(packed.content).toContain('a-first.txt:1 first');
    expect(packed.content).toContain('a-first.txt:2 second');
    expect(packed.content).toContain('nested/middle.ts:1 export const value = 1;');
  });

  it('prepends declared statements from permissions and questionnaire answers', async () => {
    await writeFixture('SKILL.md', '# Demo\n');

    const packed = await packContent(baseInput({
      questionnaireResponses: {
        externalNetwork: false,
        notes: 'No sockets or HTTP clients.',
      },
    }));

    expect(packed.content).toMatch(/^# Declared statements/);
    expect(packed.content).toContain('"network": false');
    expect(packed.content).toContain('"externalNetwork": false');
    expect(packed.content).toContain('# Extracted content');
  });

  it('sets truncated when the derived content budget is small', async () => {
    await writeFixture('a.txt', 'a'.repeat(200));
    await writeFixture('b.txt', 'b'.repeat(200));

    const packed = await packContent(baseInput({
      contextTokens: 80,
      estimatedRubricTokens: 5,
      reserveOutputTokens: 5,
      safetyMarginTokens: 5,
      charsPerToken: 1,
    }));

    expect(packed.budgetTokens).toBe(65);
    expect(packed.estimatedTokens).toBeLessThanOrEqual(65);
    expect(packed.truncated).toBe(true);
    expect(packed.includedFiles).toEqual([]);
  });
});

async function writeFixture(path: string, content: string): Promise<void> {
  const fullPath = join(tempDir, path);
  await mkdir(join(fullPath, '..'), { recursive: true });
  await writeFile(fullPath, content);
}

function baseInput(overrides: Partial<Parameters<typeof packContent>[0]> = {}): Parameters<typeof packContent>[0] {
  return {
    extractedDir: tempDir,
    manifest,
    estimatedRubricTokens: 100,
    contextTokens: 10_000,
    reserveOutputTokens: 500,
    safetyMarginTokens: 100,
    charsPerToken: 4,
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
