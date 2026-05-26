import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../migrations/index.js';
import {
  findSubmissionIdByContentHash,
  getBlockedHash,
  type BlockedHashRow,
} from './versions.js';

function insertSubmissionRow(
  db: Database.Database,
  id: string,
  contentHash: string,
): void {
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
    contentHash,
    '2026-05-24T00:00:00.000Z',
    'submitter@example.com',
    'submitted',
    '{"phase":"submitted"}',
  );
}

function insertBlockedHashRow(db: Database.Database, row: BlockedHashRow): void {
  db.prepare(
    `
      INSERT INTO blocked_hashes (
        content_hash,
        skill_name,
        version,
        blocked_at,
        blocked_by,
        reason,
        source
      )
      VALUES (
        @content_hash,
        @skill_name,
        @version,
        @blocked_at,
        @blocked_by,
        @reason,
        @source
      )
    `,
  ).run(row);
}

describe('versions repository', () => {
  let db: Database.Database | undefined;

  afterEach(() => {
    db?.close();
    db = undefined;
  });

  describe('findSubmissionIdByContentHash', () => {
    it('returns the submission id when the content hash matches', () => {
      db = new Database(':memory:');
      runMigrations(db);
      insertSubmissionRow(db, 'submission-1', 'abc');

      expect(findSubmissionIdByContentHash(db, 'abc')).toBe('submission-1');
    });

    it('returns undefined when no submission has that content hash', () => {
      db = new Database(':memory:');
      runMigrations(db);
      insertSubmissionRow(db, 'submission-1', 'abc');

      expect(findSubmissionIdByContentHash(db, 'zzz')).toBeUndefined();
    });
  });

  describe('getBlockedHash', () => {
    it('returns the blocked-hash row when the content hash is blocked', () => {
      db = new Database(':memory:');
      runMigrations(db);
      const row: BlockedHashRow = {
        content_hash: 'abc',
        skill_name: 'acme/x',
        version: '1.0.0',
        blocked_at: '2026-05-24T00:00:00.000Z',
        blocked_by: 'reviewer@example.com',
        reason: 'malicious content',
        source: 'rejected',
      };
      insertBlockedHashRow(db, row);

      const fetched = getBlockedHash(db, 'abc');
      expect(fetched).toEqual(row);
      expect(fetched?.source).toBe('rejected');
    });

    it('returns undefined for an unknown content hash', () => {
      db = new Database(':memory:');
      runMigrations(db);

      expect(getBlockedHash(db, 'unknown')).toBeUndefined();
    });
  });
});
