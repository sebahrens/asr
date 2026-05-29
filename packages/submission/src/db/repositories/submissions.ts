import type { SkillClassification, SkillManifest, Submission, SubmissionStatus } from '@asr/core';
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

export interface SubmissionRow {
  id: string;
  manifest_json: string;
  classification: SkillClassification;
  content_hash: string;
  submitted_at: string;
  submitted_by: string;
  branch_name: string | null;
  pr_number: number | null;
  status_phase: string;
  status_json: string;
  lock_version: number;
}

export function insertSubmission(db: Database.Database, row: SubmissionInsertRow): void {
  if (row.submittedBy.trim() === '') {
    throw new Error('submitted_by_required');
  }

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

export function getSubmissionById(
  db: Database.Database,
  id: string,
): SubmissionRow | undefined {
  const row = db
    .prepare(
      `
        SELECT
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
        FROM submissions
        WHERE id = ?
      `,
    )
    .get(id) as SubmissionRow | undefined;

  return row;
}

export function listSubmissionsBySubmitter(
  db: Database.Database,
  submittedBy: string,
  limit = 50,
): SubmissionRow[] {
  return db
    .prepare(
      `
        SELECT
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
        FROM submissions
        WHERE submitted_by = ?
        ORDER BY submitted_at DESC
        LIMIT ?
      `,
    )
    .all(submittedBy, limit) as SubmissionRow[];
}

export function listSubmissionsByStatusPhase(
  db: Database.Database,
  statusPhase: string,
  limit = 50,
): SubmissionRow[] {
  return db
    .prepare(
      `
        SELECT
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
        FROM submissions
        WHERE status_phase = ?
        ORDER BY submitted_at ASC
        LIMIT ?
      `,
    )
    .all(statusPhase, limit) as SubmissionRow[];
}

export function rowToSubmission(row: SubmissionRow): Submission {
  const manifest = JSON.parse(row.manifest_json) as SkillManifest;
  const status = JSON.parse(row.status_json) as SubmissionStatus;

  return {
    id: row.id,
    manifest,
    classification: row.classification,
    contentHash: row.content_hash,
    submittedAt: row.submitted_at,
    submittedBy: row.submitted_by,
    ...(row.branch_name !== null ? { branchName: row.branch_name } : {}),
    ...(row.pr_number !== null ? { prNumber: row.pr_number } : {}),
    status,
  };
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
