import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../migrations/index.js';
import { insertSubmission, updateSubmissionStatus } from './submissions.js';

describe('submissions repository', () => {
  let db: Database.Database | undefined;

  afterEach(() => {
    db?.close();
    db = undefined;
  });

  it('guards status updates with the expected lock version', () => {
    db = new Database(':memory:');
    runMigrations(db);

    insertSubmission(db, {
      id: 'submission-1',
      manifestJson: '{}',
      classification: 'md-only',
      contentHash: 'sha256:abc123',
      submittedAt: '2026-05-24T10:00:00.000Z',
      submittedBy: 'submitter@example.com',
      statusPhase: 'submitted',
      statusJson: '{"phase":"submitted"}',
    });

    const firstUpdate = {
      statusPhase: 'scanning',
      statusJson: '{"phase":"scanning"}',
    };
    const staleUpdate = {
      statusPhase: 'approved',
      statusJson: '{"phase":"approved"}',
    };

    expect(updateSubmissionStatus(db, 'submission-1', 0, firstUpdate)).toBe(true);
    expect(updateSubmissionStatus(db, 'submission-1', 0, staleUpdate)).toBe(false);

    const row = db
      .prepare(
        `
          SELECT status_phase, status_json, lock_version
          FROM submissions
          WHERE id = ?
        `,
      )
      .get('submission-1') as
      | { status_phase: string; status_json: string; lock_version: number }
      | undefined;

    expect(row).toEqual({
      status_phase: firstUpdate.statusPhase,
      status_json: firstUpdate.statusJson,
      lock_version: 1,
    });
  });
});
