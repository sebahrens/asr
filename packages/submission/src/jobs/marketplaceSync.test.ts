import { describe, expect, it } from 'vitest';
import { buildMarketplaceFiles } from './marketplaceSync.js';

describe('buildMarketplaceFiles', () => {
  it('builds marketplace manifest and per-plugin files for published skills', () => {
    const result = buildMarketplaceFiles([
      {
        name: 'summarizer',
        version: '1.0.0',
        description: 'Summarizes documents',
        kind: 'skill',
        skillMd: '# Summarizer\n',
      },
      {
        name: 'reviewer',
        version: '2.1.0',
        description: 'Reviews code',
        kind: 'persona',
        skillMd: '# Reviewer\n',
      },
    ]);

    expect(result.manifest).toEqual({
      name: 'skill-marketplace',
      version: '1',
      plugins: [
        {
          name: 'summarizer',
          version: '1.0.0',
          description: 'Summarizes documents',
          path: 'plugins/summarizer',
          kind: 'skill',
        },
        {
          name: 'reviewer',
          version: '2.1.0',
          description: 'Reviews code',
          path: 'plugins/reviewer',
          kind: 'persona',
        },
      ],
    });

    expect(result.files).toEqual(
      expect.arrayContaining([
        {
          path: 'plugins/summarizer/.claude-plugin/plugin.json',
          content: JSON.stringify(
            {
              name: 'summarizer',
              version: '1.0.0',
              description: 'Summarizes documents',
            },
            null,
            2,
          ).concat('\n'),
        },
        {
          path: 'plugins/summarizer/.codex-plugin/plugin.json',
          content: JSON.stringify(
            {
              name: 'summarizer',
              version: '1.0.0',
              description: 'Summarizes documents',
            },
            null,
            2,
          ).concat('\n'),
        },
        {
          path: 'plugins/summarizer/skills/summarizer/SKILL.md',
          content: '# Summarizer\n',
        },
        {
          path: 'plugins/reviewer/.claude-plugin/plugin.json',
          content: JSON.stringify(
            {
              name: 'reviewer',
              version: '2.1.0',
              description: 'Reviews code',
            },
            null,
            2,
          ).concat('\n'),
        },
        {
          path: 'plugins/reviewer/.codex-plugin/plugin.json',
          content: JSON.stringify(
            {
              name: 'reviewer',
              version: '2.1.0',
              description: 'Reviews code',
            },
            null,
            2,
          ).concat('\n'),
        },
        {
          path: 'plugins/reviewer/skills/reviewer/SKILL.md',
          content: '# Reviewer\n',
        },
      ]),
    );
    expect(result.files).toHaveLength(6);
  });
});
