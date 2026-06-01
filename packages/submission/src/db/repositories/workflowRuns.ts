import type Database from 'better-sqlite3';
import type { ApprovalPipelineContext } from '../../workflow/approvalPipeline.js';

export interface WorkflowRunRecord {
  id: string;
  submittedBy: string;
  serializedContext: string;
  context: ApprovalPipelineContext;
  submissionLockVersion?: number;
  submissionStatusPhase?: string;
}

interface WorkflowRunRow {
  submission_id: string;
  submitted_by: string;
  serialized_context: string;
  context_json: string;
  lock_version: number;
  status_phase: string;
}

export function getWorkflowRun(
  db: Database.Database,
  submissionId: string,
): WorkflowRunRecord | undefined {
  const row = db
    .prepare(
      `
        SELECT
          wr.submission_id,
          s.submitted_by,
          wr.serialized_context,
          wr.context_json,
          s.lock_version,
          s.status_phase
        FROM workflow_runs wr
        JOIN submissions s ON s.id = wr.submission_id
        WHERE wr.submission_id = ?
      `,
    )
    .get(submissionId) as WorkflowRunRow | undefined;

  return row ? rowToWorkflowRun(row) : undefined;
}

export function listWorkflowRuns(db: Database.Database): WorkflowRunRecord[] {
  const rows = db
    .prepare(
      `
        SELECT
          wr.submission_id,
          s.submitted_by,
          wr.serialized_context,
          wr.context_json,
          s.lock_version,
          s.status_phase
        FROM workflow_runs wr
        JOIN submissions s ON s.id = wr.submission_id
        ORDER BY wr.updated_at DESC
      `,
    )
    .all() as WorkflowRunRow[];

  return rows.map(rowToWorkflowRun);
}

export function saveWorkflowRun(
  db: Database.Database,
  record: WorkflowRunRecord,
  now = new Date(),
): void {
  const timestamp = now.toISOString();
  db.prepare(
    `
      INSERT INTO workflow_runs (
        submission_id,
        serialized_context,
        context_json,
        status,
        created_at,
        updated_at
      ) VALUES (
        @submissionId,
        @serializedContext,
        @contextJson,
        @status,
        @timestamp,
        @timestamp
      )
      ON CONFLICT(submission_id) DO UPDATE SET
        serialized_context = excluded.serialized_context,
        context_json = excluded.context_json,
        status = excluded.status,
        updated_at = excluded.updated_at
    `,
  ).run({
    submissionId: record.id,
    serializedContext: record.serializedContext,
    contextJson: JSON.stringify(record.context),
    status: record.context.status ?? record.context.submission.status.phase,
    timestamp,
  });
}

function rowToWorkflowRun(row: WorkflowRunRow): WorkflowRunRecord {
  const context = JSON.parse(row.context_json) as ApprovalPipelineContext;
  return {
    id: row.submission_id,
    submittedBy: row.submitted_by,
    serializedContext: row.serialized_context,
    context,
    submissionLockVersion: row.lock_version,
    submissionStatusPhase: row.status_phase,
  };
}
