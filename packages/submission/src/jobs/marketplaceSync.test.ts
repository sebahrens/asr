import { describe, expect, it, vi } from 'vitest';
import { buildMarketplaceFiles, syncMarketplaceRepo } from './marketplaceSync.js';

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

describe('syncMarketplaceRepo', () => {
  it('opens and merges a marketplace repo PR with generated marketplace files', async () => {
    const openSubmissionPR = vi.fn().mockResolvedValue({
      branch: 'submit/marketplace-sync-1',
      prNumber: 17,
      headSha: 'head-sha',
    });
    const mergePR = vi.fn().mockResolvedValue({ sha: 'merge-sha' });

    const result = await syncMarketplaceRepo({
      client: { openSubmissionPR, mergePR },
      readPublishedSkills: async () => [
        {
          name: 'summarizer',
          version: '1.0.0',
          description: 'Summarizes documents',
          kind: 'skill',
          skillMd: '# Summarizer\n',
        },
      ],
    });

    expect(openSubmissionPR).toHaveBeenCalledTimes(1);
    expect(openSubmissionPR).toHaveBeenCalledWith(
      expect.objectContaining({
        autoApprove: true,
        branch: expect.stringMatching(/^marketplace-sync\//),
        pathPrefix: '',
        files: expect.arrayContaining([
          expect.objectContaining({ path: 'marketplace.json' }),
          expect.objectContaining({ path: 'plugins/summarizer/.claude-plugin/plugin.json' }),
        ]),
      }),
    );
    expect(mergePR).toHaveBeenCalledWith(17);
    expect(result).toEqual({ prNumber: 17, merged: true });
  });
});
