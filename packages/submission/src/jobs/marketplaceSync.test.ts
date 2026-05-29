import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetMarketplaceSyncPagerState,
  buildMarketplaceFiles,
  runMarketplaceSync,
  syncMarketplaceRepo,
} from './marketplaceSync.js';

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
        idempotent: true,
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

describe('runMarketplaceSync', () => {
  beforeEach(() => {
    __resetMarketplaceSyncPagerState();
  });

  it('emits marketplace_sync.failed on every failure but rate-limits the pager to once per hour per skill', async () => {
    const emitAudit = vi.fn();
    const pager = vi.fn();
    const openSubmissionPR = vi.fn().mockRejectedValue(new Error('forgejo unavailable'));
    const mergePR = vi.fn();

    const now = vi.fn();
    now.mockReturnValueOnce(1_000_000);
    now.mockReturnValueOnce(1_000_000 + 60_000); // +60s — same hour

    const deps = {
      client: { openSubmissionPR, mergePR },
      readPublishedSkills: async () => [
        {
          name: 'summarizer',
          version: '1.0.0',
          description: 'Summarizes documents',
          kind: 'skill' as const,
          skillMd: '# Summarizer\n',
        },
      ],
      emitAudit,
      pager,
      now,
    };

    await expect(runMarketplaceSync('summarizer', deps)).rejects.toThrow('forgejo unavailable');
    await expect(runMarketplaceSync('summarizer', deps)).rejects.toThrow('forgejo unavailable');

    expect(emitAudit).toHaveBeenCalledTimes(2);
    expect(emitAudit).toHaveBeenNthCalledWith(1, {
      action: 'marketplace_sync.failed',
      skillName: 'summarizer',
      actor: 'system',
      actorType: 'system',
      detail: { skillName: 'summarizer', error: 'forgejo unavailable' },
    });
    expect(pager).toHaveBeenCalledTimes(1);
    expect(pager).toHaveBeenCalledWith('summarizer', expect.any(Error));
  });

  it('pages again once the per-skill 1-hour window elapses', async () => {
    const emitAudit = vi.fn();
    const pager = vi.fn();
    const openSubmissionPR = vi.fn().mockRejectedValue(new Error('boom'));
    const mergePR = vi.fn();

    const now = vi.fn();
    now.mockReturnValueOnce(1_000_000);
    now.mockReturnValueOnce(1_000_000 + 3_600_000); // exactly +1h

    const deps = {
      client: { openSubmissionPR, mergePR },
      readPublishedSkills: async () => [],
      emitAudit,
      pager,
      now,
    };

    await expect(runMarketplaceSync('flapper', deps)).rejects.toThrow('boom');
    await expect(runMarketplaceSync('flapper', deps)).rejects.toThrow('boom');

    expect(pager).toHaveBeenCalledTimes(2);
  });

  it('returns the sync result, emits success, and does not page on success', async () => {
    const emitAudit = vi.fn();
    const pager = vi.fn();
    const openSubmissionPR = vi.fn().mockResolvedValue({
      branch: 'submit/marketplace-sync-ok',
      prNumber: 42,
      headSha: 'sha',
    });
    const mergePR = vi.fn().mockResolvedValue({ sha: 'merge-sha' });

    const deps = {
      client: { openSubmissionPR, mergePR },
      readPublishedSkills: async () => [],
      emitAudit,
      pager,
    };

    const result = await runMarketplaceSync('summarizer', deps);

    expect(result).toEqual({ prNumber: 42, merged: true });
    expect(emitAudit).toHaveBeenCalledTimes(1);
    expect(emitAudit).toHaveBeenCalledWith({
      action: 'marketplace_sync.succeeded',
      skillName: 'summarizer',
      actor: 'system',
      actorType: 'system',
      detail: { skillName: 'summarizer', prNumber: 42 },
    });
    expect(pager).not.toHaveBeenCalled();
  });

  it('writes only the triggered skill files plus marketplace.json', async () => {
    const emitAudit = vi.fn();
    const pager = vi.fn();
    const openSubmissionPR = vi.fn().mockResolvedValue({
      branch: 'submit/marketplace-sync-incremental',
      prNumber: 51,
      headSha: 'sha',
    });
    const mergePR = vi.fn().mockResolvedValue({ sha: 'merge-sha' });

    await runMarketplaceSync('summarizer', {
      client: { openSubmissionPR, mergePR },
      readPublishedSkills: async () => [
        {
          name: 'summarizer',
          version: '1.0.0',
          description: 'Summarizes documents',
          kind: 'skill' as const,
          skillMd: '# Summarizer\n',
        },
        {
          name: 'reviewer',
          version: '2.0.0',
          description: 'Reviews code',
          kind: 'persona' as const,
          skillMd: '# Reviewer\n',
        },
      ],
      emitAudit,
      pager,
    });

    const files = openSubmissionPR.mock.calls[0][0].files as Array<{ path: string }>;
    expect(files.map((file) => file.path)).toEqual([
      'marketplace.json',
      'plugins/summarizer/.claude-plugin/plugin.json',
      'plugins/summarizer/.codex-plugin/plugin.json',
      'plugins/summarizer/skills/summarizer/SKILL.md',
    ]);
  });

  it('writes only marketplace.json when the triggered skill is no longer published', async () => {
    const emitAudit = vi.fn();
    const pager = vi.fn();
    const openSubmissionPR = vi.fn().mockResolvedValue({
      branch: 'submit/marketplace-sync-yank',
      prNumber: 52,
      headSha: 'sha',
    });
    const mergePR = vi.fn().mockResolvedValue({ sha: 'merge-sha' });

    await runMarketplaceSync('summarizer', {
      client: { openSubmissionPR, mergePR },
      readPublishedSkills: async () => [
        {
          name: 'reviewer',
          version: '2.0.0',
          description: 'Reviews code',
          kind: 'persona' as const,
          skillMd: '# Reviewer\n',
        },
      ],
      emitAudit,
      pager,
    });

    const files = openSubmissionPR.mock.calls[0][0].files as Array<{ path: string }>;
    expect(files.map((file) => file.path)).toEqual(['marketplace.json']);
  });
});
