import { rsortVersions } from '@asr/core';
import type Database from 'better-sqlite3';

export interface SkillVersionRow {
  skill_name: string;
  version: string;
  content_hash: string;
  submission_id: string;
  published_at: string;
  published_by: string;
  approved_by: string | null;
  pr_number: number;
  merge_commit: string;
  scan_report_id: string | null;
  yanked_at: string | null;
  yanked_by: string | null;
  yank_reason: string | null;
}

export function insertSkillVersion(db: Database.Database, row: SkillVersionRow): void {
  db.prepare(
    `
      INSERT INTO skill_versions (
        skill_name,
        version,
        content_hash,
        submission_id,
        published_at,
        published_by,
        approved_by,
        pr_number,
        merge_commit,
        scan_report_id,
        yanked_at,
        yanked_by,
        yank_reason
      ) VALUES (
        @skill_name,
        @version,
        @content_hash,
        @submission_id,
        @published_at,
        @published_by,
        @approved_by,
        @pr_number,
        @merge_commit,
        @scan_report_id,
        @yanked_at,
        @yanked_by,
        @yank_reason
      )
    `,
  ).run(row);
}

export function getSkillVersion(
  db: Database.Database,
  skillName: string,
  version: string,
): SkillVersionRow | undefined {
  const row = db
    .prepare(
      `
        SELECT
          skill_name,
          version,
          content_hash,
          submission_id,
          published_at,
          published_by,
          approved_by,
          pr_number,
          merge_commit,
          scan_report_id,
          yanked_at,
          yanked_by,
          yank_reason
        FROM skill_versions
        WHERE skill_name = ? AND version = ?
      `,
    )
    .get(skillName, version) as SkillVersionRow | undefined;

  return row;
}

export function listVersions(
  db: Database.Database,
  skillName: string,
): SkillVersionRow[] {
  return db
    .prepare(
      `
        SELECT
          skill_name,
          version,
          content_hash,
          submission_id,
          published_at,
          published_by,
          approved_by,
          pr_number,
          merge_commit,
          scan_report_id,
          yanked_at,
          yanked_by,
          yank_reason
        FROM skill_versions
        WHERE skill_name = ?
      `,
    )
    .all(skillName) as SkillVersionRow[];
}

export function resolveLatestVersion(
  db: Database.Database,
  skillName: string,
): string | undefined {
  const rows = db
    .prepare(
      `
        SELECT version
        FROM skill_versions
        WHERE skill_name = ? AND yanked_at IS NULL
      `,
    )
    .all(skillName) as Array<{ version: string }>;

  if (rows.length === 0) {
    return undefined;
  }

  const sorted = rsortVersions(rows.map((r) => r.version));
  return sorted[0];
}
