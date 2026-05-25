import type { Database } from '../db/index.js';

function isPendingVersionContention(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return false;
  }

  const code = (error as { code: unknown }).code;

  return code === 'SQLITE_CONSTRAINT_PRIMARYKEY' || code === 'SQLITE_CONSTRAINT';
}

export function acquirePendingVersion(
  db: Database,
  skillName: string,
  version: string,
  submissionId: string,
): boolean {
  try {
    db.prepare(
      `
        INSERT INTO pending_versions (
          skill_name,
          version,
          submission_id,
          acquired_at
        )
        VALUES (?, ?, ?, ?)
      `,
    ).run(skillName, version, submissionId, new Date().toISOString());

    return true;
  } catch (error) {
    if (isPendingVersionContention(error)) {
      return false;
    }

    throw error;
  }
}

export function releasePendingVersion(db: Database, skillName: string, version: string): void {
  db.prepare('DELETE FROM pending_versions WHERE skill_name = ? AND version = ?').run(
    skillName,
    version,
  );
}
