import type { SkillManifest, Submission } from '@asr/core';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../migrations/index.js';
import {
  getSubmissionById,
  insertSubmission,
  listSubmissionsByStatusPhase,
  listSubmissionsBySubmitter,
  rowToSubmission,
  updateSubmissionStatus,
} from './submissions.js';

describe('submissions repository', () => {
  let db: Database.Database | undefined;

  afterEach(() => {
    db?.close();
    db = undefined;
  });

  it('round-trips a full md-only Submission through insert/get/rowToSubmission', () => {
    db = new Database(':memory:');
    runMigrations(db);

    const manifest: SkillManifest = {
      name: 'demo-skill',
      version: '1.0.0',
      author: 'submitter@example.com',
      description: 'Demo md-only skill for round-trip tests',
      tags: ['demo', 'test'],
      kind: 'skill',
      permissions: {
        network: false,
        filesystem: 'none',
        subprocess: false,
        environment: [],
      },
    };

    const submission: Submission = {
      id: 'submission-rt-1',
      manifest,
      classification: 'md-only',
      contentHash: 'sha256:roundtrip',
      submittedAt: '2026-05-24T10:00:00.000Z',
      submittedBy: 'submitter@example.com',
      status: { phase: 'uploaded' },
    };

    insertSubmission(db, {
      id: submission.id,
      manifestJson: JSON.stringify(submission.manifest),
      classification: submission.classification,
      contentHash: submission.contentHash,
      submittedAt: submission.submittedAt,
      submittedBy: submission.submittedBy,
      statusPhase: submission.status.phase,
      statusJson: JSON.stringify(submission.status),
    });

    const row = getSubmissionById(db, submission.id);
    expect(row).toBeDefined();
    expect(row?.lock_version).toBe(0);
    expect(row?.branch_name).toBeNull();
    expect(row?.pr_number).toBeNull();

    const hydrated = rowToSubmission(row!);
    expect(hydrated.status.phase).toBe('uploaded');
    expect(hydrated.manifest.name).toBe(manifest.name);
    expect(hydrated.manifest).toEqual(manifest);
    expect(hydrated.classification).toBe('md-only');
    expect(hydrated.contentHash).toBe(submission.contentHash);
    expect(hydrated.branchName).toBeUndefined();
    expect(hydrated.prNumber).toBeUndefined();
  });

  it('preserves branchName and prNumber through rowToSubmission when set', () => {
    db = new Database(':memory:');
    runMigrations(db);

    insertSubmission(db, {
      id: 'submission-rt-2',
      manifestJson: '{}',
      classification: 'md-only',
      contentHash: 'sha256:branch',
      submittedAt: '2026-05-24T10:00:00.000Z',
      submittedBy: 'submitter@example.com',
      branchName: 'submission/foo-1.0.0',
      prNumber: 42,
      statusPhase: 'pushing-to-forgejo',
      statusJson: '{"phase":"pushing-to-forgejo"}',
    });

    const row = getSubmissionById(db, 'submission-rt-2');
    const hydrated = rowToSubmission(row!);

    expect(hydrated.branchName).toBe('submission/foo-1.0.0');
    expect(hydrated.prNumber).toBe(42);
    expect(hydrated.status).toEqual({ phase: 'pushing-to-forgejo' });
  });

  it('returns undefined when no submission matches the id', () => {
    db = new Database(':memory:');
    runMigrations(db);

    expect(getSubmissionById(db, 'missing-id')).toBeUndefined();
  });

  it('lists only own submissions newest-first when filtering by submitted_by', () => {
    db = new Database(':memory:');
    runMigrations(db);

    insertSubmission(db, {
      id: 'submission-userA-older',
      manifestJson: '{}',
      classification: 'md-only',
      contentHash: 'sha256:a-older',
      submittedAt: '2026-05-24T09:00:00.000Z',
      submittedBy: 'userA',
      statusPhase: 'submitted',
      statusJson: '{"phase":"submitted"}',
    });
    insertSubmission(db, {
      id: 'submission-userA-newer',
      manifestJson: '{}',
      classification: 'md-only',
      contentHash: 'sha256:a-newer',
      submittedAt: '2026-05-24T11:00:00.000Z',
      submittedBy: 'userA',
      statusPhase: 'submitted',
      statusJson: '{"phase":"submitted"}',
    });
    insertSubmission(db, {
      id: 'submission-userB',
      manifestJson: '{}',
      classification: 'md-only',
      contentHash: 'sha256:b',
      submittedAt: '2026-05-24T10:00:00.000Z',
      submittedBy: 'userB',
      statusPhase: 'submitted',
      statusJson: '{"phase":"submitted"}',
    });

    const rows = listSubmissionsBySubmitter(db, 'userA');
    expect(rows.map((r) => r.id)).toEqual([
      'submission-userA-newer',
      'submission-userA-older',
    ]);
    expect(rows.every((r) => r.submitted_by === 'userA')).toBe(true);
  });

  it('respects the limit parameter when listing by submitter', () => {
    db = new Database(':memory:');
    runMigrations(db);

    for (let i = 0; i < 3; i += 1) {
      insertSubmission(db, {
        id: `submission-${i}`,
        manifestJson: '{}',
        classification: 'md-only',
        contentHash: `sha256:${i}`,
        submittedAt: `2026-05-24T1${i}:00:00.000Z`,
        submittedBy: 'userA',
        statusPhase: 'submitted',
        statusJson: '{"phase":"submitted"}',
      });
    }

    const rows = listSubmissionsBySubmitter(db, 'userA', 2);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.id)).toEqual(['submission-2', 'submission-1']);
  });

  it('returns an empty array when no submissions match the submitter', () => {
    db = new Database(':memory:');
    runMigrations(db);

    expect(listSubmissionsBySubmitter(db, 'ghost')).toEqual([]);
  });

  it('lists submissions matching a status_phase oldest-first', () => {
    db = new Database(':memory:');
    runMigrations(db);

    insertSubmission(db, {
      id: 'cr-newer',
      manifestJson: '{}',
      classification: 'md-only',
      contentHash: 'sha256:cr-newer',
      submittedAt: '2026-05-24T12:00:00.000Z',
      submittedBy: 'alice',
      statusPhase: 'compliance-review',
      statusJson: '{"phase":"compliance-review"}',
    });
    insertSubmission(db, {
      id: 'cr-older',
      manifestJson: '{}',
      classification: 'md-only',
      contentHash: 'sha256:cr-older',
      submittedAt: '2026-05-24T10:00:00.000Z',
      submittedBy: 'bob',
      statusPhase: 'compliance-review',
      statusJson: '{"phase":"compliance-review"}',
    });
    insertSubmission(db, {
      id: 'scan',
      manifestJson: '{}',
      classification: 'md-only',
      contentHash: 'sha256:scan',
      submittedAt: '2026-05-24T11:00:00.000Z',
      submittedBy: 'carol',
      statusPhase: 'scanning',
      statusJson: '{"phase":"scanning","scanJobId":"s1"}',
    });

    const rows = listSubmissionsByStatusPhase(db, 'compliance-review');
    expect(rows.map((r) => r.id)).toEqual(['cr-older', 'cr-newer']);
    expect(rows.every((r) => r.status_phase === 'compliance-review')).toBe(true);
  });

  it('respects the limit parameter when listing by status_phase', () => {
    db = new Database(':memory:');
    runMigrations(db);

    for (let i = 0; i < 3; i += 1) {
      insertSubmission(db, {
        id: `phase-${i}`,
        manifestJson: '{}',
        classification: 'md-only',
        contentHash: `sha256:phase-${i}`,
        submittedAt: `2026-05-24T1${i}:00:00.000Z`,
        submittedBy: 'queue-user',
        statusPhase: 'compliance-review',
        statusJson: '{"phase":"compliance-review"}',
      });
    }

    const rows = listSubmissionsByStatusPhase(db, 'compliance-review', 2);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.id)).toEqual(['phase-0', 'phase-1']);
  });

  it('returns an empty array when no submissions match the status_phase', () => {
    db = new Database(':memory:');
    runMigrations(db);

    expect(listSubmissionsByStatusPhase(db, 'compliance-review')).toEqual([]);
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
