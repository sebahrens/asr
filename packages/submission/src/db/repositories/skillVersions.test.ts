import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../migrations/index.js';
import {
  getSkillVersion,
  insertSkillVersion,
  listVersions,
  markVersionYanked,
  resolveLatestVersion,
  type SkillVersionRow,
} from './skillVersions.js';

const SUBMISSION_ID = 'submission-sv-1';

function insertSubmissionRow(db: Database.Database, id: string): void {
  db.prepare(
    `
      INSERT INTO submissions (
        id,
        manifest_json,
        classification,
        content_hash,
        submitted_at,
        submitted_by,
        status_phase,
        status_json
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `,
  ).run(
    id,
    '{}',
    'md-only',
    `sha256:${id}`,
    '2026-05-24T00:00:00.000Z',
    'submitter@example.com',
    'published',
    '{"phase":"published"}',
  );
}

function sampleRow(overrides: Partial<SkillVersionRow> = {}): SkillVersionRow {
  return {
    owner: 'acme',
    skill_name: 'acme/x',
    version: '1.0.0',
    content_hash: 'sha256:abc',
    submission_id: SUBMISSION_ID,
    published_at: '2026-05-24T10:00:00.000Z',
    published_by: 'submitter@example.com',
    approved_by: null,
    pr_number: 42,
    merge_commit: 'merge-sha-1',
    scan_report_id: null,
    yanked_at: null,
    yanked_by: null,
    yank_reason: null,
    ...overrides,
  };
}

describe('skillVersions repository', () => {
  let db: Database.Database | undefined;

  afterEach(() => {
    db?.close();
    db = undefined;
  });

  it('round-trips a SkillVersionRow through insert/get', () => {
    db = new Database(':memory:');
    runMigrations(db);
    insertSubmissionRow(db, SUBMISSION_ID);

    const row = sampleRow();
    insertSkillVersion(db, row);

    const fetched = getSkillVersion(db, 'acme/x', '1.0.0');
    expect(fetched).toEqual(row);
    expect(fetched?.merge_commit).toBe('merge-sha-1');
    expect(fetched?.content_hash).toBe('sha256:abc');
    expect(fetched?.yanked_at).toBeNull();
  });

  it('returns undefined for unknown (skill_name, version)', () => {
    db = new Database(':memory:');
    runMigrations(db);
    insertSubmissionRow(db, SUBMISSION_ID);
    insertSkillVersion(db, sampleRow());

    expect(getSkillVersion(db, 'acme/x', '9.9.9')).toBeUndefined();
    expect(getSkillVersion(db, 'other/skill', '1.0.0')).toBeUndefined();
  });

  it('throws on duplicate (skill_name, version) insert', () => {
    db = new Database(':memory:');
    runMigrations(db);
    insertSubmissionRow(db, SUBMISSION_ID);

    insertSkillVersion(db, sampleRow());

    expect(() => {
      insertSkillVersion(
        db!,
        sampleRow({ content_hash: 'sha256:other', merge_commit: 'merge-sha-2' }),
      );
    }).toThrow();
  });

  it('allows the same skill/version under different owners', () => {
    db = new Database(':memory:');
    runMigrations(db);
    insertSubmissionRow(db, SUBMISSION_ID);
    insertSubmissionRow(db, `${SUBMISSION_ID}-other`);

    insertSkillVersion(db, sampleRow());
    insertSkillVersion(
      db,
      sampleRow({
        owner: 'other-team',
        content_hash: 'sha256:other',
        submission_id: `${SUBMISSION_ID}-other`,
        merge_commit: 'merge-other',
      }),
    );

    expect(getSkillVersion(db, 'acme/x', '1.0.0', 'acme')?.merge_commit).toBe('merge-sha-1');
    expect(getSkillVersion(db, 'acme/x', '1.0.0', 'other-team')?.merge_commit).toBe('merge-other');
  });

  describe('markVersionYanked', () => {
    it('sets yanked_at/by/reason and returns true on a live row', () => {
      db = new Database(':memory:');
      runMigrations(db);
      insertSubmissionRow(db, SUBMISSION_ID);
      insertSkillVersion(db, sampleRow());

      const result = markVersionYanked(db, 'acme/x', '1.0.0', {
        yankedAt: '2026-01-01T00:00:00.000Z',
        yankedBy: 'compliance@example.com',
        reason: 'leak',
      });

      expect(result).toBe(true);

      const fetched = getSkillVersion(db, 'acme/x', '1.0.0');
      expect(fetched?.yanked_at).toBe('2026-01-01T00:00:00.000Z');
      expect(fetched?.yanked_by).toBe('compliance@example.com');
      expect(fetched?.yank_reason).toBe('leak');
    });

    it('returns false when the version is already yanked (idempotent)', () => {
      db = new Database(':memory:');
      runMigrations(db);
      insertSubmissionRow(db, SUBMISSION_ID);
      insertSkillVersion(db, sampleRow());

      const first = markVersionYanked(db, 'acme/x', '1.0.0', {
        yankedAt: '2026-01-01T00:00:00.000Z',
        yankedBy: 'compliance@example.com',
        reason: 'leak',
      });
      const second = markVersionYanked(db, 'acme/x', '1.0.0', {
        yankedAt: '2026-02-01T00:00:00.000Z',
        yankedBy: 'other@example.com',
        reason: 'duplicate',
      });

      expect(first).toBe(true);
      expect(second).toBe(false);

      const fetched = getSkillVersion(db, 'acme/x', '1.0.0');
      expect(fetched?.yanked_at).toBe('2026-01-01T00:00:00.000Z');
      expect(fetched?.yanked_by).toBe('compliance@example.com');
      expect(fetched?.yank_reason).toBe('leak');
    });

    it('returns false for an unknown (skill_name, version)', () => {
      db = new Database(':memory:');
      runMigrations(db);

      const result = markVersionYanked(db, 'missing/skill', '1.0.0', {
        yankedAt: '2026-01-01T00:00:00.000Z',
        yankedBy: 'compliance@example.com',
        reason: 'leak',
      });

      expect(result).toBe(false);
    });
  });

  describe('listVersions / resolveLatestVersion', () => {
    function seedThreeVersions(database: Database.Database, skillName: string): void {
      insertSubmissionRow(database, `${SUBMISSION_ID}-100`);
      insertSubmissionRow(database, `${SUBMISSION_ID}-110`);
      insertSubmissionRow(database, `${SUBMISSION_ID}-120`);

      insertSkillVersion(
        database,
        sampleRow({
          skill_name: skillName,
          version: '1.0.0',
          content_hash: 'sha256:v100',
          submission_id: `${SUBMISSION_ID}-100`,
          merge_commit: 'merge-100',
        }),
      );
      insertSkillVersion(
        database,
        sampleRow({
          skill_name: skillName,
          version: '1.1.0',
          content_hash: 'sha256:v110',
          submission_id: `${SUBMISSION_ID}-110`,
          merge_commit: 'merge-110',
        }),
      );
      insertSkillVersion(
        database,
        sampleRow({
          skill_name: skillName,
          version: '1.2.0',
          content_hash: 'sha256:v120',
          submission_id: `${SUBMISSION_ID}-120`,
          merge_commit: 'merge-120',
          yanked_at: '2026-02-01T00:00:00.000Z',
          yanked_by: 'compliance@example.com',
          yank_reason: 'leak',
        }),
      );
    }

    it('resolveLatestVersion ignores yanked rows and returns highest semver', () => {
      db = new Database(':memory:');
      runMigrations(db);
      seedThreeVersions(db, 'acme/x');

      expect(resolveLatestVersion(db, 'acme/x')).toBe('1.1.0');

      const rows = listVersions(db, 'acme/x');
      expect(rows).toHaveLength(3);
      const byVersion = new Map(rows.map((r) => [r.version, r]));
      expect(byVersion.get('1.0.0')?.yanked_at).toBeNull();
      expect(byVersion.get('1.1.0')?.yanked_at).toBeNull();
      expect(byVersion.get('1.2.0')?.yanked_at).toBe('2026-02-01T00:00:00.000Z');
      expect(byVersion.get('1.2.0')?.yanked_by).toBe('compliance@example.com');
      expect(byVersion.get('1.2.0')?.yank_reason).toBe('leak');
    });

    it('resolveLatestVersion is undefined when all versions yanked', () => {
      db = new Database(':memory:');
      runMigrations(db);
      insertSubmissionRow(db, SUBMISSION_ID);

      insertSkillVersion(
        db,
        sampleRow({
          skill_name: 'acme/y',
          version: '1.0.0',
          submission_id: SUBMISSION_ID,
          yanked_at: '2026-02-01T00:00:00.000Z',
          yanked_by: 'compliance@example.com',
          yank_reason: 'leak',
        }),
      );

      expect(resolveLatestVersion(db, 'acme/y')).toBeUndefined();
      expect(listVersions(db, 'acme/y')).toHaveLength(1);
    });

    it('resolveLatestVersion is undefined for an unknown skill', () => {
      db = new Database(':memory:');
      runMigrations(db);

      expect(resolveLatestVersion(db, 'missing/skill')).toBeUndefined();
      expect(listVersions(db, 'missing/skill')).toEqual([]);
    });

    it('resolveLatestVersion uses semver ordering, not lexicographic', () => {
      db = new Database(':memory:');
      runMigrations(db);
      insertSubmissionRow(db, `${SUBMISSION_ID}-2`);
      insertSubmissionRow(db, `${SUBMISSION_ID}-10`);

      insertSkillVersion(
        db,
        sampleRow({
          skill_name: 'acme/z',
          version: '0.2.0',
          submission_id: `${SUBMISSION_ID}-2`,
        }),
      );
      insertSkillVersion(
        db,
        sampleRow({
          skill_name: 'acme/z',
          version: '0.10.0',
          submission_id: `${SUBMISSION_ID}-10`,
        }),
      );

      expect(resolveLatestVersion(db, 'acme/z')).toBe('0.10.0');
    });
  });
});
