import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runMigrations } from '../db/migrations/index.js';
import { findResumableSubmissions, resumeWorkflows } from './resume.js';

describe('workflow resume', () => {
  let db: Database.Database | undefined;

  afterEach(() => {
    db?.close();
    db = undefined;
    vi.restoreAllMocks();
  });

  function openMigratedDatabase(): Database.Database {
    db = new Database(':memory:');
    runMigrations(db);
    return db;
  }

  function insertSubmission(database: Database.Database, id: string, statusPhase: string): void {
    database
      .prepare(
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
      )
      .run(
        id,
        '{}',
        'md-only',
        `sha256:${id}`,
        '2026-05-24T00:00:00.000Z',
        'submitter@example.com',
        statusPhase,
        JSON.stringify({ phase: statusPhase }),
      );
  }

  it('finds non-terminal submissions', () => {
    const database = openMigratedDatabase();

    insertSubmission(database, 'submission-scan', 'scan');
    insertSubmission(database, 'submission-questionnaire', 'questionnaire');
    insertSubmission(database, 'submission-published', 'published');

    expect(findResumableSubmissions(database)).toEqual([
      { id: 'submission-questionnaire', statusPhase: 'questionnaire' },
      { id: 'submission-scan', statusPhase: 'scan' },
    ]);
  });

  it('re-enters each resumable submission and counts successful resumes', async () => {
    const database = openMigratedDatabase();
    const fakeReenter = vi.fn<(submissionId: string) => Promise<void>>().mockResolvedValue();

    insertSubmission(database, 'submission-scan', 'scan');
    insertSubmission(database, 'submission-questionnaire', 'questionnaire');
    insertSubmission(database, 'submission-published', 'published');

    await expect(resumeWorkflows(database, fakeReenter)).resolves.toEqual({ resumed: 2 });
    expect(fakeReenter).toHaveBeenCalledTimes(2);
    expect(fakeReenter).toHaveBeenNthCalledWith(1, 'submission-questionnaire');
    expect(fakeReenter).toHaveBeenNthCalledWith(2, 'submission-scan');
  });

  it('logs failed re-entry and continues with remaining submissions', async () => {
    const database = openMigratedDatabase();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const fakeReenter = vi
      .fn<(submissionId: string) => Promise<void>>()
      .mockRejectedValueOnce(new Error('resume failed'))
      .mockResolvedValueOnce();

    insertSubmission(database, 'submission-questionnaire', 'questionnaire');
    insertSubmission(database, 'submission-scan', 'scan');

    await expect(resumeWorkflows(database, fakeReenter)).resolves.toEqual({ resumed: 1 });
    expect(fakeReenter).toHaveBeenCalledTimes(2);
    expect(errorSpy).toHaveBeenCalledWith('Failed to resume workflow', {
      submissionId: 'submission-questionnaire',
      error: expect.any(Error),
    });
  });
});
