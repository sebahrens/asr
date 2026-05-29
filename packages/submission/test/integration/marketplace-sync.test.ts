import type { ForgejoClient, SkillManifest } from '@asr/core';
import { Buffer } from 'node:buffer';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runMigrations } from '../../src/db/migrations/index.js';
import { insertSkillVersion, markVersionYanked } from '../../src/db/repositories/skillVersions.js';
import { insertSubmission } from '../../src/db/repositories/submissions.js';
import {
  __resetMarketplaceSyncPagerState,
  runMarketplaceSync,
  type MarketplaceSkillInput,
  type RunMarketplaceSyncDeps,
} from '../../src/jobs/marketplaceSync.js';

// Story-level acceptance signal for asr-3d8: end-to-end proof that the marketplace
// repo stays in sync on version.published / version.yanked, and that a forced
// failure pages exactly once per hour. Uses an in-memory SQLite DB seeded the same
// way publishMdOnly / the yank route would seed it, and a captured FakeForgejoClient
// (the existing integration-test convention — see yank.test.ts).

const ACME = 'acme';
const SKILL_X = 'x';
const SKILL_Y = 'y';
const VERSION = '1.0.0';
const X_SKILL_MD = '# x\nAcme x body.\n';
const Y_SKILL_MD = '# y\nAcme y body.\n';

describe('marketplace sync integration', () => {
  let db: Database.Database | undefined;
  let forgejo: FakeForgejoClient | undefined;

  beforeEach(() => {
    __resetMarketplaceSyncPagerState();
    db = new Database(':memory:');
    runMigrations(db);
    forgejo = new FakeForgejoClient();
  });

  afterEach(() => {
    db?.close();
    db = undefined;
    forgejo = undefined;
  });

  it('opens a marketplace PR with marketplace.json and per-plugin files when version.published fires', async () => {
    seedPublishedVersion(db!, {
      author: ACME,
      name: SKILL_X,
      version: VERSION,
      description: 'Acme x',
      skillMd: X_SKILL_MD,
    });

    const result = await runMarketplaceSync(SKILL_X, makeDeps(db!, forgejo!));

    expect(result).toEqual({ prNumber: 1, merged: true });

    expect(forgejo!.openCalls).toHaveLength(1);
    expect(forgejo!.mergeCalls).toEqual([1]);

    const opened = forgejo!.openCalls[0];
    expect(opened.autoApprove).toBe(true);
    expect(opened.pathPrefix).toBe('');
    expect(opened.branch).toMatch(/^marketplace-sync\//);
    expect(opened.labels).toEqual(['auto-approve', 'marketplace-sync']);

    const paths = opened.files.map((f) => f.path);
    expect(paths).toEqual(
      expect.arrayContaining([
        'marketplace.json',
        `plugins/${SKILL_X}/.claude-plugin/plugin.json`,
        `plugins/${SKILL_X}/.codex-plugin/plugin.json`,
        `plugins/${SKILL_X}/skills/${SKILL_X}/SKILL.md`,
      ]),
    );

    const manifest = readJson<{ name: string; plugins: Array<{ name: string; version: string; path: string }> }>(
      opened.files,
      'marketplace.json',
    );
    expect(manifest.name).toBe('skill-marketplace');
    expect(manifest.plugins).toEqual([
      expect.objectContaining({ name: SKILL_X, version: VERSION, path: `plugins/${SKILL_X}` }),
    ]);

    const skillMdFile = opened.files.find((f) => f.path === `plugins/${SKILL_X}/skills/${SKILL_X}/SKILL.md`);
    expect(skillMdFile!.content.toString('utf8')).toBe(X_SKILL_MD);
  });

  it('removes the yanked plugin entry on the next sync after version.yanked fires', async () => {
    seedPublishedVersion(db!, {
      author: ACME,
      name: SKILL_X,
      version: VERSION,
      description: 'Acme x',
      skillMd: X_SKILL_MD,
    });
    seedPublishedVersion(db!, {
      author: ACME,
      name: SKILL_Y,
      version: VERSION,
      description: 'Acme y',
      skillMd: Y_SKILL_MD,
    });

    await runMarketplaceSync(SKILL_X, makeDeps(db!, forgejo!));
    const beforeYank = readJson<{ plugins: Array<{ name: string }> }>(
      forgejo!.openCalls[0].files,
      'marketplace.json',
    );
    expect(beforeYank.plugins.map((p) => p.name).sort()).toEqual([SKILL_X, SKILL_Y]);

    markVersionYanked(db!, SKILL_X, VERSION, {
      yankedAt: '2026-05-21T00:00:00.000Z',
      yankedBy: 'carol',
      reason: 'leak',
    });

    await runMarketplaceSync(SKILL_X, makeDeps(db!, forgejo!));

    expect(forgejo!.openCalls).toHaveLength(2);
    const afterYank = readJson<{ plugins: Array<{ name: string }> }>(
      forgejo!.openCalls[1].files,
      'marketplace.json',
    );
    expect(afterYank.plugins.map((p) => p.name)).toEqual([SKILL_Y]);

    const afterYankPaths = forgejo!.openCalls[1].files.map((f) => f.path);
    expect(afterYankPaths).not.toContain(`plugins/${SKILL_X}/.claude-plugin/plugin.json`);
    expect(afterYankPaths).not.toContain(`plugins/${SKILL_X}/.codex-plugin/plugin.json`);
    expect(afterYankPaths).not.toContain(`plugins/${SKILL_X}/skills/${SKILL_X}/SKILL.md`);
    expect(afterYankPaths).toContain(`plugins/${SKILL_Y}/skills/${SKILL_Y}/SKILL.md`);
  });

  it('reuses the content-addressed marketplace PR for identical published skill sets', async () => {
    seedPublishedVersion(db!, {
      author: ACME,
      name: SKILL_X,
      version: VERSION,
      description: 'Acme x',
      skillMd: X_SKILL_MD,
    });

    const deps = makeDeps(db!, forgejo!);
    const first = await runMarketplaceSync(SKILL_X, deps);
    const second = await runMarketplaceSync(SKILL_X, deps);

    expect(second).toEqual(first);
    expect(forgejo!.openCalls).toHaveLength(1);
    expect(forgejo!.mergeCalls).toEqual([1, 1]);
  });

  it('recovers on retry without a second PR after a merge failure', async () => {
    seedPublishedVersion(db!, {
      author: ACME,
      name: SKILL_X,
      version: VERSION,
      description: 'Acme x',
      skillMd: X_SKILL_MD,
    });

    forgejo!.failNextMerge = new Error('merge interrupted');

    await expect(runMarketplaceSync(SKILL_X, makeDeps(db!, forgejo!))).rejects.toThrow(
      'merge interrupted',
    );
    const retry = await runMarketplaceSync(SKILL_X, makeDeps(db!, forgejo!));

    expect(retry).toEqual({ prNumber: 1, merged: true });
    expect(forgejo!.openCalls).toHaveLength(1);
    expect(forgejo!.mergeCalls).toEqual([1, 1]);
  });

  it('serializes concurrent marketplace sync invocations through publish_locks', async () => {
    seedPublishedVersion(db!, {
      author: ACME,
      name: SKILL_X,
      version: VERSION,
      description: 'Acme x',
      skillMd: X_SKILL_MD,
    });

    forgejo!.openDelayMs = 10;

    const [first, second] = await Promise.all([
      runMarketplaceSync(SKILL_X, makeDeps(db!, forgejo!)),
      runMarketplaceSync(SKILL_X, makeDeps(db!, forgejo!)),
    ]);

    expect(first).toEqual({ prNumber: 1, merged: true });
    expect(second).toEqual({ prNumber: 1, merged: true });
    expect(forgejo!.openCalls).toHaveLength(1);
    expect(forgejo!.maxActiveOpens).toBe(1);
  });

  it('emits marketplace_sync.failed and pages exactly once per skill per hour on forced failure', async () => {
    seedPublishedVersion(db!, {
      author: ACME,
      name: SKILL_X,
      version: VERSION,
      description: 'Acme x',
      skillMd: X_SKILL_MD,
    });

    const breaking = new FakeForgejoClient({ failOpen: new Error('forgejo down') });
    const emitAudit = vi.fn();
    const pager = vi.fn();
    const now = vi
      .fn<() => number>()
      .mockReturnValueOnce(2_000_000)
      .mockReturnValueOnce(2_000_000 + 60_000); // +60s, well within the 1h window

    const deps = {
      ...makeDeps(db!, breaking),
      emitAudit,
      pager,
      now,
    };

    await expect(runMarketplaceSync(SKILL_X, deps)).rejects.toThrow('forgejo down');
    await expect(runMarketplaceSync(SKILL_X, deps)).rejects.toThrow('forgejo down');

    expect(emitAudit).toHaveBeenCalledTimes(2);
    expect(emitAudit).toHaveBeenNthCalledWith(1, {
      action: 'marketplace_sync.failed',
      skillName: SKILL_X,
      actor: 'system',
      actorType: 'system',
      detail: { skillName: SKILL_X, error: 'forgejo down' },
    });
    expect(pager).toHaveBeenCalledTimes(1);
    expect(pager).toHaveBeenCalledWith(SKILL_X, expect.any(Error));

    expect(breaking.openCalls).toHaveLength(2);
    expect(breaking.mergeCalls).toEqual([]);
  });
});

interface SeedInput {
  author: string;
  name: string;
  version: string;
  description: string;
  skillMd: string;
}

function seedPublishedVersion(db: Database.Database, input: SeedInput): void {
  const submissionId = `sub-${input.author}-${input.name}-${input.version}`;
  const manifest: SkillManifest = {
    name: input.name,
    version: input.version,
    author: input.author,
    description: input.description,
    tags: ['integration'],
    kind: 'skill',
    permissions: {
      network: false,
      filesystem: 'read-own',
      subprocess: false,
      environment: [],
    },
  };

  insertSubmission(db, {
    id: submissionId,
    manifestJson: JSON.stringify(manifest),
    classification: 'md-only',
    contentHash: `sha256:hash-${input.name}-${input.version}`,
    submittedAt: '2026-05-20T00:00:00.000Z',
    submittedBy: input.author,
    statusPhase: 'published',
    statusJson: JSON.stringify({
      phase: 'published',
      publishedAt: '2026-05-20T00:00:00.000Z',
      mergeCommit: `merge-${input.name}`,
      skillMd: input.skillMd,
    }),
  });

  insertSkillVersion(db, {
    skill_name: input.name,
    version: input.version,
    content_hash: `sha256:hash-${input.name}-${input.version}`,
    submission_id: submissionId,
    published_at: '2026-05-20T00:00:00.000Z',
    published_by: input.author,
    approved_by: null,
    pr_number: 1,
    merge_commit: `merge-${input.name}`,
    scan_report_id: null,
    yanked_at: null,
    yanked_by: null,
    yank_reason: null,
  });
}

function makeDeps(db: Database.Database, forgejo: FakeForgejoClient): RunMarketplaceSyncDeps & {
  emitAudit: ReturnType<typeof vi.fn>;
  pager: ReturnType<typeof vi.fn>;
} {
  return {
    db,
    client: forgejo as unknown as Pick<ForgejoClient, 'openSubmissionPR' | 'mergePR'>,
    readPublishedSkills: async () => readNonYankedPublishedSkills(db),
    emitAudit: vi.fn(),
    pager: vi.fn(),
  };
}

function readNonYankedPublishedSkills(db: Database.Database): MarketplaceSkillInput[] {
  const rows = db
    .prepare(
      `
        SELECT
          s.manifest_json AS manifest_json,
          s.status_json   AS status_json
        FROM skill_versions sv
        JOIN submissions s ON s.id = sv.submission_id
        WHERE sv.yanked_at IS NULL
        ORDER BY sv.skill_name
      `,
    )
    .all() as Array<{ manifest_json: string; status_json: string }>;

  return rows.map((row) => {
    const manifest = JSON.parse(row.manifest_json) as SkillManifest;
    const status = JSON.parse(row.status_json) as { skillMd?: string };
    return {
      name: manifest.name,
      version: manifest.version,
      description: manifest.description,
      kind: manifest.kind,
      skillMd: status.skillMd ?? '',
    };
  });
}

function readJson<T>(files: Array<{ path: string; content: Buffer }>, path: string): T {
  const file = files.find((f) => f.path === path);
  if (!file) {
    throw new Error(`expected marketplace PR to include file: ${path}`);
  }
  return JSON.parse(file.content.toString('utf8')) as T;
}

interface OpenPRCall {
  submissionId: string;
  branch?: string;
  pathPrefix?: string;
  labels?: string[];
  files: Array<{ path: string; content: Buffer }>;
  autoApprove: boolean;
  idempotent?: boolean;
}

class FakeForgejoClient {
  openCalls: OpenPRCall[] = [];
  mergeCalls: number[] = [];
  failNextMerge: Error | undefined;
  openDelayMs = 0;
  activeOpens = 0;
  maxActiveOpens = 0;
  private readonly prsByBranch = new Map<string, { prNumber: number; branch: string; headSha: string }>();

  constructor(private readonly opts: { failOpen?: Error } = {}) {}

  async openSubmissionPR(input: OpenPRCall): Promise<{ branch: string; prNumber: number; headSha: string }> {
    const branch = input.branch ?? `submit/${input.submissionId}`;
    const existing = this.prsByBranch.get(branch);
    if (input.idempotent && existing) {
      return {
        branch: existing.branch,
        prNumber: existing.prNumber,
        headSha: existing.headSha,
      };
    }

    this.activeOpens += 1;
    this.maxActiveOpens = Math.max(this.maxActiveOpens, this.activeOpens);
    if (this.openDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.openDelayMs));
    }

    this.openCalls.push(input);
    try {
      if (this.opts.failOpen) {
        throw this.opts.failOpen;
      }
      const prNumber = this.openCalls.length;
      const result = {
        branch,
        prNumber,
        headSha: `head-${prNumber}`,
      };
      this.prsByBranch.set(branch, result);
      return result;
    } finally {
      this.activeOpens -= 1;
    }
  }

  async mergePR(prNumber: number): Promise<{ sha: string }> {
    this.mergeCalls.push(prNumber);
    if (this.failNextMerge) {
      const error = this.failNextMerge;
      this.failNextMerge = undefined;
      throw error;
    }
    return { sha: `merge-${prNumber}` };
  }
}
