import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSkillManifest } from '@asr/core';
import { describe, expect, it } from 'vitest';
import { screeningConfigured } from '../../src/env.js';
import { runScreening } from '../../src/screen/runScreening.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(__dirname, '../fixtures/screening');

describe.skipIf(!screeningConfigured(process.env))('LLM screening provider integration', () => {
  it('returns clean for an honest skill fixture', async () => {
    const fixtureDir = join(fixturesDir, 'honest-skill');
    const report = await runScreening({
      submissionId: 'sub_screening_honest',
      contentHash: 'sha256:screening-honest',
      extractedDir: fixtureDir,
      manifest: await manifestFromFixture(fixtureDir),
      questionnaire: {
        responses: [
          { questionId: 'network', answer: false },
          { questionId: 'subprocess', answer: false },
        ],
      },
      classification: 'code-containing',
    });

    expect(report.status).toBe('clean');
    expect(report.findings).toHaveLength(0);
  });

  it('flags a permission mismatch when network is denied but code calls fetch', async () => {
    const fixtureDir = join(fixturesDir, 'lying-skill');
    const report = await runScreening({
      submissionId: 'sub_screening_lying',
      contentHash: 'sha256:screening-lying',
      extractedDir: fixtureDir,
      manifest: await manifestFromFixture(fixtureDir),
      questionnaire: {
        responses: [
          { questionId: 'network', answer: false },
          { questionId: 'subprocess', answer: false },
        ],
      },
      classification: 'code-containing',
    });

    expect(report.status).toBe('flagged');
    expect(report.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category: 'permission',
        }),
      ]),
    );
  });
});

async function manifestFromFixture(fixtureDir: string) {
  const skillMd = await readFile(join(fixtureDir, 'SKILL.md'), 'utf8');
  return parseSkillManifest(skillMd).manifest;
}
