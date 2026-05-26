import type Database from 'better-sqlite3';

export interface BlockedHashRow {
  content_hash: string;
  skill_name: string;
  version: string;
  blocked_at: string;
  blocked_by: string;
  reason: string;
  source: 'rejected' | 'yanked' | 'incident';
}

export function findSubmissionIdByContentHash(
  db: Database.Database,
  contentHash: string,
): string | undefined {
  const row = db
    .prepare(`SELECT id FROM submissions WHERE content_hash = ? LIMIT 1`)
    .get(contentHash) as { id: string } | undefined;

  return row?.id;
}

export function getBlockedHash(
  db: Database.Database,
  contentHash: string,
): BlockedHashRow | undefined {
  const row = db
    .prepare(
      `
        SELECT
          content_hash,
          skill_name,
          version,
          blocked_at,
          blocked_by,
          reason,
          source
        FROM blocked_hashes
        WHERE content_hash = ?
      `,
    )
    .get(contentHash) as BlockedHashRow | undefined;

  return row;
}
