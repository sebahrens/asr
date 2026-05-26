import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../migrations/index.js';
import {
  getSkillVersion,
  insertSkillVersion,
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
});
