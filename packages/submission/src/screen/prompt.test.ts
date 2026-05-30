import { describe, expect, it } from 'vitest';
import {
  SCREENING_SYSTEM_RUBRIC,
  buildScreeningUserContent,
} from './prompt.js';

describe('SCREENING_SYSTEM_RUBRIC', () => {
  it('defines the four canonical screening categories and output shape', () => {
    expect(SCREENING_SYSTEM_RUBRIC).toContain('permission:');
    expect(SCREENING_SYSTEM_RUBRIC).toContain('questionnaire:');
    expect(SCREENING_SYSTEM_RUBRIC).toContain('description:');
    expect(SCREENING_SYSTEM_RUBRIC).toContain('malicious:');
    expect(SCREENING_SYSTEM_RUBRIC).toContain('"findings"');
    expect(SCREENING_SYSTEM_RUBRIC).toContain('ScreeningFinding');
    expect(SCREENING_SYSTEM_RUBRIC).toContain('critical|high|medium|low');
  });

  it('keeps provider-specific structured output details out of the static rubric', () => {
    expect(SCREENING_SYSTEM_RUBRIC).not.toMatch(/openai/i);
    expect(SCREENING_SYSTEM_RUBRIC).not.toMatch(/anthropic/i);
    expect(SCREENING_SYSTEM_RUBRIC).not.toMatch(/response_format/i);
    expect(SCREENING_SYSTEM_RUBRIC).not.toMatch(/tool_choice/i);
  });
});

describe('buildScreeningUserContent', () => {
  it('wraps packed content with deterministic per-skill metadata', () => {
    const userContent = buildScreeningUserContent({
      packed: {
        content: [
          '# Declared statements',
          '## Permissions manifest',
          '{"network":false}',
          '# Extracted content',
          'scripts/run.sh:1 fetch("https://example.test")',
        ].join('\n'),
        truncated: true,
        includedFiles: ['SKILL.md', 'scripts/run.sh'],
        skippedFiles: ['assets/logo.png'],
        budgetTokens: 1000,
        estimatedTokens: 998,
      },
    });

    expect(userContent).toMatch(/^# Screening input/);
    expect(userContent).toContain('truncated: true');
    expect(userContent).toContain('budgetTokens: 1000');
    expect(userContent).toContain('estimatedTokens: 998');
    expect(userContent).toContain('includedFiles: SKILL.md, scripts/run.sh');
    expect(userContent).toContain('skippedFiles: assets/logo.png');
    expect(userContent).toContain('scripts/run.sh:1 fetch("https://example.test")');
  });

  it('renders empty file lists explicitly', () => {
    const userContent = buildScreeningUserContent({
      packed: {
        content: '',
        truncated: false,
        includedFiles: [],
        skippedFiles: [],
        budgetTokens: 10,
        estimatedTokens: 0,
      },
    });

    expect(userContent).toContain('includedFiles: (none)');
    expect(userContent).toContain('skippedFiles: (none)');
  });
});
