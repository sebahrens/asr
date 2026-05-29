import { rsortVersions } from '@asr/core';
import type Database from 'better-sqlite3';
import { ownerFromPrincipal } from '../../identity/owners.js';

export interface SkillVersionRow {
  owner: string;
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

export type InsertSkillVersionRow = Omit<SkillVersionRow, 'owner'> & { owner?: string };

export function insertSkillVersion(db: Database.Database, row: InsertSkillVersionRow): void {
  const owner = row.owner ?? ownerFromPrincipal(row.published_by);
  db.prepare(
    `
      INSERT INTO skill_versions (
        owner,
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
        @owner,
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
  ).run({ ...row, owner });
}

export function getSkillVersion(
  db: Database.Database,
  skillName: string,
  version: string,
  owner?: string,
): SkillVersionRow | undefined {
  const ownerSql = owner === undefined ? '' : 'AND owner = ?';
  const params = owner === undefined ? [skillName, version] : [skillName, version, owner];
  const row = db
    .prepare(
      `
        SELECT
          owner,
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
          ${ownerSql}
      `,
    )
    .get(...params) as SkillVersionRow | undefined;

  return row;
}

export function listVersions(
  db: Database.Database,
  skillName: string,
  owner?: string,
): SkillVersionRow[] {
  const ownerSql = owner === undefined ? '' : 'AND owner = ?';
  const params = owner === undefined ? [skillName] : [skillName, owner];
  return db
    .prepare(
      `
        SELECT
          owner,
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
          ${ownerSql}
      `,
    )
    .all(...params) as SkillVersionRow[];
}

export function markVersionYanked(
  db: Database.Database,
  skillName: string,
  version: string,
  input: { yankedAt: string; yankedBy: string; reason: string },
  owner?: string,
): boolean {
  const ownerSql = owner === undefined ? '' : 'AND owner = ?';
  const params =
    owner === undefined
      ? [input.yankedAt, input.yankedBy, input.reason, skillName, version]
      : [input.yankedAt, input.yankedBy, input.reason, skillName, version, owner];
  const info = db
    .prepare(
      `
        UPDATE skill_versions
        SET yanked_at = ?, yanked_by = ?, yank_reason = ?
        WHERE skill_name = ? AND version = ? AND yanked_at IS NULL
          ${ownerSql}
      `,
    )
    .run(...params);

  return info.changes === 1;
}

export function resolveLatestVersion(
  db: Database.Database,
  skillName: string,
  owner?: string,
): string | undefined {
  const ownerSql = owner === undefined ? '' : 'AND owner = ?';
  const params = owner === undefined ? [skillName] : [skillName, owner];
  const rows = db
    .prepare(
      `
        SELECT version
        FROM skill_versions
        WHERE skill_name = ? AND yanked_at IS NULL
          ${ownerSql}
      `,
    )
    .all(...params) as Array<{ version: string }>;

  if (rows.length === 0) {
    return undefined;
  }

  const sorted = rsortVersions(rows.map((r) => r.version));
  return sorted[0];
}
