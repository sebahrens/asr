import type { SkillKind, SkillManifest } from '@asr/core';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../migrations/index.js';
import {
  getPublishedSkill,
  getPublishedSkillVersion,
  listPublishedSkills,
} from './skills.js';
import { insertSkillVersion, markVersionYanked } from './skillVersions.js';
import { insertSubmission } from './submissions.js';

describe('published skills repository', () => {
  let db: Database.Database | undefined;

  afterEach(() => {
    db?.close();
    db = undefined;
  });

  it('lists published skill summaries and returns detail with all versions', () => {
    db = new Database(':memory:');
    runMigrations(db);

    insertPublishedSubmission(db, {
      id: 'submission-x-100',
      version: '1.0.0',
      submittedAt: '2026-05-23T10:00:00.000Z',
      publishedAt: '2026-05-23T10:05:00.000Z',
      contentHash: 'sha256:x-100',
    });
    insertPublishedSubmission(db, {
      id: 'submission-x-110',
      version: '1.1.0',
      submittedAt: '2026-05-24T10:00:00.000Z',
      publishedAt: '2026-05-24T10:05:00.000Z',
      contentHash: 'sha256:x-110',
    });

    const listed = listPublishedSkills(db);

    expect(listed.items).toEqual([
      expect.objectContaining({
        owner: 'acme',
        name: 'x',
        latestVersion: '1.1.0',
        description: 'Skill x 1.1.0',
        tags: ['automation', 'review'],
        kind: 'skill',
        publishedAt: '2026-05-24T10:05:00.000Z',
        downloadCount: 0,
        riskAssessmentLatest: 'low',
      }),
    ]);
    expect(listed.nextOffset).toBeNull();

    const detail = getPublishedSkill(db, 'acme', 'x');

    expect(detail).toEqual(
      expect.objectContaining({
        owner: 'acme',
        name: 'x',
        latestVersion: '1.1.0',
        manifestLatest: expect.objectContaining({ version: '1.1.0' }),
      }),
    );
    expect(detail?.versions.map((version) => version.version)).toEqual(['1.1.0', '1.0.0']);
    expect(detail?.versions).toHaveLength(2);
  });

  it('filters by query, tag, and kind before paginating', () => {
    db = new Database(':memory:');
    runMigrations(db);

    insertPublishedSubmission(db, {
      id: 'submission-x',
      name: 'x',
      version: '1.0.0',
      tags: ['automation', 'review'],
      submittedAt: '2026-05-24T10:00:00.000Z',
      publishedAt: '2026-05-24T10:05:00.000Z',
    });
    insertPublishedSubmission(db, {
      id: 'submission-y',
      name: 'y',
      version: '1.0.0',
      description: 'Persona for release notes',
      tags: ['writing'],
      kind: 'persona',
      submittedAt: '2026-05-25T10:00:00.000Z',
      publishedAt: '2026-05-25T10:05:00.000Z',
    });
    insertPublishedSubmission(db, {
      id: 'submission-z',
      name: 'z',
      version: '1.0.0',
      tags: ['automation'],
      submittedAt: '2026-05-26T10:00:00.000Z',
      publishedAt: '2026-05-26T10:05:00.000Z',
    });

    expect(listPublishedSkills(db, { q: 'release' }).items.map((skill) => skill.name)).toEqual(['y']);
    expect(listPublishedSkills(db, { tag: 'automation', kind: 'skill' }).items.map((skill) => skill.name)).toEqual([
      'z',
      'x',
    ]);

    const firstPage = listPublishedSkills(db, { limit: 1 });
    expect(firstPage.items.map((skill) => skill.name)).toEqual(['z']);
    expect(firstPage.nextOffset).toBe(1);

    const secondPage = listPublishedSkills(db, { limit: 1, offset: firstPage.nextOffset ?? 0 });
    expect(secondPage.items.map((skill) => skill.name)).toEqual(['y']);
    expect(secondPage.nextOffset).toBe(2);
  });

  it('ignores non-published submissions', () => {
    db = new Database(':memory:');
    runMigrations(db);

    insertSubmission(db, {
      id: 'submission-draft',
      manifestJson: JSON.stringify(manifest({ name: 'draft', version: '1.0.0' })),
      classification: 'md-only',
      contentHash: 'sha256:draft',
      submittedAt: '2026-05-24T10:00:00.000Z',
      submittedBy: 'submitter@example.com',
      statusPhase: 'submitted',
      statusJson: '{"phase":"submitted"}',
    });

    expect(listPublishedSkills(db).items).toEqual([]);
    expect(getPublishedSkill(db, 'acme', 'draft')).toBeUndefined();
  });

  it('resolves a specific published version with its manifest', () => {
    db = new Database(':memory:');
    runMigrations(db);

    insertPublishedSubmission(db, {
      id: 'submission-x-090',
      version: '0.9.0',
      submittedAt: '2026-05-22T10:00:00.000Z',
      publishedAt: '2026-05-22T10:05:00.000Z',
      contentHash: 'sha256:x-090',
      yankedAt: '2026-05-22T11:00:00.000Z',
      yankReason: 'security',
    });
    insertPublishedSubmission(db, {
      id: 'submission-x-100',
      version: '1.0.0',
      submittedAt: '2026-05-23T10:00:00.000Z',
      publishedAt: '2026-05-23T10:05:00.000Z',
      contentHash: 'sha256:x-100',
    });
    insertPublishedSubmission(db, {
      id: 'submission-x-110',
      version: '1.1.0',
      submittedAt: '2026-05-24T10:00:00.000Z',
      publishedAt: '2026-05-24T10:05:00.000Z',
      contentHash: 'sha256:x-110',
    });

    const exact = getPublishedSkillVersion(db, 'acme', 'x', '1.0.0');
    expect(exact?.manifest.version).toBe('1.0.0');
    expect(exact?.skillVersion.contentHash).toBe('sha256:x-100');
    expect(exact?.skillVersion.yanked).toBe(false);

    const defaulted = getPublishedSkillVersion(db, 'acme', 'x');
    expect(defaulted?.skillVersion.version).toBe('1.1.0');
    expect(defaulted?.skillVersion.yanked).toBe(false);

    const yanked = getPublishedSkillVersion(db, 'acme', 'x', '0.9.0');
    expect(yanked?.skillVersion.yanked).toBe(true);
    expect(yanked?.skillVersion.yankReason).toBe('security');

    expect(getPublishedSkillVersion(db, 'acme', 'x', '9.9.9')).toBeUndefined();
    expect(getPublishedSkillVersion(db, 'acme', 'missing')).toBeUndefined();
  });

  it('derives yanked state from skill_versions instead of submission status_json', () => {
    db = new Database(':memory:');
    runMigrations(db);

    insertPublishedSubmission(db, {
      id: 'submission-x-100',
      version: '1.0.0',
      submittedAt: '2026-05-23T10:00:00.000Z',
      publishedAt: '2026-05-23T10:05:00.000Z',
      contentHash: 'sha256:x-100',
      includeSkillVersion: true,
    });

    markVersionYanked(db, 'x', '1.0.0', {
      yankedAt: '2026-05-23T11:00:00.000Z',
      yankedBy: 'compliance@example.com',
      reason: 'security',
    });

    const resolved = getPublishedSkillVersion(db, 'acme', 'x', '1.0.0');

    expect(resolved?.skillVersion.yanked).toBe(true);
    expect(resolved?.skillVersion.yankedAt).toBe('2026-05-23T11:00:00.000Z');
    expect(resolved?.skillVersion.yankReason).toBe('security');
  });
});

interface PublishedSubmissionFixture {
  id: string;
  name?: string;
  version: string;
  description?: string;
  tags?: string[];
  kind?: SkillKind;
  submittedAt: string;
  publishedAt: string;
  contentHash?: string;
  yankedAt?: string;
  yankReason?: string;
  includeSkillVersion?: boolean;
}

function insertPublishedSubmission(db: Database.Database, fixture: PublishedSubmissionFixture): void {
  const status: Record<string, unknown> = {
    phase: 'published',
    publishedAt: fixture.publishedAt,
    mergeCommit: `merge-${fixture.id}`,
  };
  if (fixture.yankedAt) status.yankedAt = fixture.yankedAt;
  if (fixture.yankReason) status.yankReason = fixture.yankReason;

  insertSubmission(db, {
    id: fixture.id,
    manifestJson: JSON.stringify(
      manifest({
        name: fixture.name ?? 'x',
        version: fixture.version,
        description: fixture.description ?? `Skill ${fixture.name ?? 'x'} ${fixture.version}`,
        tags: fixture.tags,
        kind: fixture.kind,
      }),
    ),
    classification: 'md-only',
    contentHash: fixture.contentHash ?? `sha256:${fixture.id}`,
    submittedAt: fixture.submittedAt,
    submittedBy: 'submitter@example.com',
    prNumber: 42,
    statusPhase: 'published',
    statusJson: JSON.stringify(status),
  });

  if (fixture.includeSkillVersion || fixture.yankedAt) {
    const name = fixture.name ?? 'x';
    insertSkillVersion(db, {
      skill_name: name,
      version: fixture.version,
      content_hash: fixture.contentHash ?? `sha256:${fixture.id}`,
      submission_id: fixture.id,
      published_at: fixture.publishedAt,
      published_by: 'submitter@example.com',
      approved_by: null,
      pr_number: 42,
      merge_commit: `merge-${fixture.id}`,
      scan_report_id: null,
      yanked_at: fixture.yankedAt ?? null,
      yanked_by: fixture.yankedAt ? 'compliance@example.com' : null,
      yank_reason: fixture.yankReason ?? null,
    });
  }
}

function manifest(overrides: Partial<SkillManifest>): SkillManifest {
  const base: SkillManifest = {
    name: 'x',
    version: '1.0.0',
    author: 'acme',
    description: 'Skill x 1.0.0',
    tags: ['automation', 'review'],
    kind: 'skill',
    permissions: {
      network: false,
      filesystem: 'read-own',
      subprocess: false,
      environment: [],
    },
  };

  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined) {
      (base as unknown as Record<string, unknown>)[key] = value;
    }
  }

  return base;
}
