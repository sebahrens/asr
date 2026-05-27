import type { PermissionsManifest, RiskAssessment, VersionDiff } from '@asr/core';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../migrations/index.js';
import { getVersionDiff, insertVersionDiff } from './versionDiffs.js';

const SUBMISSION_ID = 'submission-vd-1';

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
    'submitted',
    '{"phase":"submitted"}',
  );
}

function basePermissions(): PermissionsManifest {
  return {
    network: false,
    subprocess: false,
    filesystem: 'none',
    environment: [],
  };
}

function sampleDiff(overrides: Partial<VersionDiff> = {}): VersionDiff {
  return {
    skillName: 'acme/x',
    fromVersion: '1.0.0',
    toVersion: '1.1.0',
    fromContentHash: 'sha256:aaa',
    toContentHash: 'sha256:bbb',
    filesAdded: ['notes.md'],
    filesRemoved: [],
    filesModified: ['SKILL.md'],
    dependenciesAdded: {},
    dependenciesRemoved: {},
    dependenciesChanged: {},
    permissionsBefore: basePermissions(),
    permissionsAfter: basePermissions(),
    permissionsExpanded: false,
    manifestKindChanged: false,
    riskAssessment: 'low',
    computedAt: '2026-05-24T10:00:00.000Z',
    ...overrides,
  };
}

describe('versionDiffs repository', () => {
  let db: Database.Database | undefined;

  afterEach(() => {
    db?.close();
    db = undefined;
  });

  it('round-trips a VersionDiff through insert/get', () => {
    db = new Database(':memory:');
    runMigrations(db);
    insertSubmissionRow(db, SUBMISSION_ID);

    const diff = sampleDiff();
    insertVersionDiff(db, SUBMISSION_ID, diff);

    const fetched = getVersionDiff(db, SUBMISSION_ID);
    expect(fetched).toBeDefined();
    expect(fetched?.diff).toEqual(diff);
    expect(fetched?.risk).toBe(diff.riskAssessment);
  });

  it('stores fromVersion as NULL when empty (initial publish)', () => {
    db = new Database(':memory:');
    runMigrations(db);
    insertSubmissionRow(db, SUBMISSION_ID);

    const diff = sampleDiff({ fromVersion: '', fromContentHash: null });
    insertVersionDiff(db, SUBMISSION_ID, diff);

    const row = db
      .prepare('SELECT from_version FROM version_diffs WHERE submission_id = ?')
      .get(SUBMISSION_ID) as { from_version: string | null };

    expect(row.from_version).toBeNull();

    const fetched = getVersionDiff(db, SUBMISSION_ID);
    expect(fetched?.diff.fromVersion).toBe('');
  });

  it('is idempotent on re-insert via INSERT OR REPLACE', () => {
    db = new Database(':memory:');
    runMigrations(db);
    insertSubmissionRow(db, SUBMISSION_ID);

    const first = sampleDiff({ riskAssessment: 'low' });
    insertVersionDiff(db, SUBMISSION_ID, first);

    const second = sampleDiff({
      riskAssessment: 'high',
      filesModified: ['SKILL.md', 'scripts/run.ts'],
      computedAt: '2026-05-24T11:00:00.000Z',
    });
    insertVersionDiff(db, SUBMISSION_ID, second);

    const fetched = getVersionDiff(db, SUBMISSION_ID);
    expect(fetched?.diff).toEqual(second);
    expect(fetched?.risk).toBe('high');

    const count = db
      .prepare('SELECT COUNT(*) AS n FROM version_diffs WHERE submission_id = ?')
      .get(SUBMISSION_ID) as { n: number };
    expect(count.n).toBe(1);
  });

  it('returns undefined for an unknown submission_id', () => {
    db = new Database(':memory:');
    runMigrations(db);
    insertSubmissionRow(db, SUBMISSION_ID);
    insertVersionDiff(db, SUBMISSION_ID, sampleDiff());

    expect(getVersionDiff(db, 'submission-missing')).toBeUndefined();
  });

  it('rejects an invalid risk value (CHECK constraint)', () => {
    db = new Database(':memory:');
    runMigrations(db);
    insertSubmissionRow(db, SUBMISSION_ID);

    const bogus = sampleDiff({ riskAssessment: 'bogus' as unknown as RiskAssessment });
    expect(() => insertVersionDiff(db!, SUBMISSION_ID, bogus)).toThrow();
  });
});
