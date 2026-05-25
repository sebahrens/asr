import type { Database } from '../db/index.js';

export const TERMINAL_PHASES = ['published', 'rejected', 'error'] as const;

export interface ResumableSubmission {
  id: string;
  statusPhase: string;
}

interface ResumableSubmissionRow {
  id: string;
  status_phase: string;
}

export function findResumableSubmissions(db: Database): ResumableSubmission[] {
  return db
    .prepare(
      `
        SELECT id, status_phase
        FROM submissions
        WHERE status_phase NOT IN ('published', 'rejected', 'error')
        ORDER BY id
      `,
    )
    .all()
    .map((row) => {
      const submission = row as ResumableSubmissionRow;

      return {
        id: submission.id,
        statusPhase: submission.status_phase,
      };
    });
}

export async function resumeWorkflows(
  db: Database,
  reenter: (submissionId: string) => Promise<void>,
): Promise<{ resumed: number }> {
  let resumed = 0;

  for (const submission of findResumableSubmissions(db)) {
    try {
      await reenter(submission.id);
      resumed += 1;
    } catch (error) {
      console.error('Failed to resume workflow', {
        submissionId: submission.id,
        error,
      });
    }
  }

  return { resumed };
}
