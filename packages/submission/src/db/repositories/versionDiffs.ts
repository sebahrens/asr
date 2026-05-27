import type { RiskAssessment, VersionDiff } from '@asr/core';
import type Database from 'better-sqlite3';

interface VersionDiffRow {
  submission_id: string;
  from_version: string | null;
  to_version: string;
  diff_json: string;
  risk: RiskAssessment;
  computed_at: string;
}

export function insertVersionDiff(
  db: Database.Database,
  submissionId: string,
  diff: VersionDiff,
): void {
  db.prepare(
    `
      INSERT OR REPLACE INTO version_diffs (
        submission_id,
        from_version,
        to_version,
        diff_json,
        risk,
        computed_at
      )
      VALUES (?, ?, ?, ?, ?, ?)
    `,
  ).run(
    submissionId,
    diff.fromVersion || null,
    diff.toVersion,
    JSON.stringify(diff),
    diff.riskAssessment,
    diff.computedAt,
  );
}

export function getVersionDiff(
  db: Database.Database,
  submissionId: string,
): { diff: VersionDiff; risk: RiskAssessment } | undefined {
  const row = db
    .prepare(
      `
        SELECT
          submission_id,
          from_version,
          to_version,
          diff_json,
          risk,
          computed_at
        FROM version_diffs
        WHERE submission_id = ?
      `,
    )
    .get(submissionId) as VersionDiffRow | undefined;

  if (row === undefined) {
    return undefined;
  }

  return {
    diff: JSON.parse(row.diff_json) as VersionDiff,
    risk: row.risk,
  };
}
