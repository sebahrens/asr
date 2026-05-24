import type { SkillClassification } from '@asr/core';
import type Database from 'better-sqlite3';

export interface SubmissionInsertRow {
  id: string;
  manifestJson: string;
  classification: SkillClassification;
  contentHash: string;
  submittedAt: string;
  submittedBy: string;
  branchName?: string | null;
  prNumber?: number | null;
  statusPhase: string;
  statusJson: string;
}

export interface SubmissionStatusUpdate {
  statusPhase: string;
  statusJson: string;
}

export function insertSubmission(db: Database.Database, row: SubmissionInsertRow): void {
  db.prepare(`
    INSERT INTO submissions (
      id,
      manifest_json,
      classification,
      content_hash,
      submitted_at,
      submitted_by,
      branch_name,
      pr_number,
      status_phase,
      status_json,
      lock_version
    ) VALUES (
      @id,
      @manifestJson,
      @classification,
      @contentHash,
      @submittedAt,
      @submittedBy,
      @branchName,
      @prNumber,
      @statusPhase,
      @statusJson,
      0
    )
  `).run({
    ...row,
    branchName: row.branchName ?? null,
    prNumber: row.prNumber ?? null,
  });
}

export function updateSubmissionStatus(
  db: Database.Database,
  id: string,
  expectedLockVersion: number,
  next: SubmissionStatusUpdate,
): boolean {
  const info = db
    .prepare(
      `
        UPDATE submissions
        SET
          status_phase = ?,
          status_json = ?,
          lock_version = lock_version + 1
        WHERE id = ? AND lock_version = ?
      `,
    )
    .run(next.statusPhase, next.statusJson, id, expectedLockVersion);

  return info.changes === 1;
}
