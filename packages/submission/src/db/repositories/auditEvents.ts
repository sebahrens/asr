import type { AuditAction, AuditEvent } from '@asr/core';
import type Database from 'better-sqlite3';

interface AuditEventRow {
  rowid: number;
  id: string;
  submission_id: string | null;
  skill_owner: string | null;
  skill_name: string | null;
  version: string | null;
  timestamp: string;
  actor: string;
  actor_type: AuditEvent['actorType'];
  action: AuditAction;
  detail: string;
  prev_hash: string;
  hash: string;
  hmac_key_id: string;
}

export interface AuditEventPageOptions {
  limit?: number;
  offset?: number;
}

export interface AuditEventPage {
  items: AuditEvent[];
  nextOffset: number | null;
}

export function mapAuditEventRow(row: AuditEventRow): AuditEvent {
  return {
    id: row.id,
    submissionId: row.submission_id,
    skillOwner: row.skill_owner,
    skillName: row.skill_name,
    version: row.version,
    timestamp: row.timestamp,
    actor: row.actor,
    actorType: row.actor_type,
    action: row.action,
    detail: JSON.parse(row.detail) as Record<string, unknown>,
    prevHash: row.prev_hash,
    hash: row.hash,
    hmacKeyId: row.hmac_key_id,
  };
}

const SELECT_COLUMNS = `
  rowid,
  id,
  submission_id,
  skill_owner,
  skill_name,
  version,
  timestamp,
  actor,
  actor_type,
  action,
  detail,
  prev_hash,
  hash,
  hmac_key_id
`;

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 100;
const MAX_OFFSET = 100_000;

export function getBySubmission(
  db: Database.Database,
  submissionId: string,
  options: AuditEventPageOptions = {},
): AuditEventPage {
  const page = normalizePageOptions(options);
  const rows = db
    .prepare(
      `
        SELECT ${SELECT_COLUMNS}
        FROM audit_events
        WHERE submission_id = ?
        ORDER BY timestamp ASC, rowid ASC
        LIMIT ? OFFSET ?
      `,
    )
    .all(submissionId, page.limit + 1, page.offset) as AuditEventRow[];

  return toPage(rows, page);
}

export function getBySkill(
  db: Database.Database,
  skillOwner: string,
  skillName: string,
  version?: string,
  options: AuditEventPageOptions = {},
): AuditEventPage {
  assertAuditSkillOwnerScoped(db);
  const page = normalizePageOptions(options);

  const rows =
    version === undefined
      ? (db
          .prepare(
            `
              SELECT ${SELECT_COLUMNS}
              FROM audit_events
              WHERE skill_owner = ? AND skill_name = ?
              ORDER BY timestamp ASC, rowid ASC
              LIMIT ? OFFSET ?
            `,
          )
          .all(skillOwner, skillName, page.limit + 1, page.offset) as AuditEventRow[])
      : (db
          .prepare(
            `
              SELECT ${SELECT_COLUMNS}
              FROM audit_events
              WHERE skill_owner = ? AND skill_name = ? AND version = ?
              ORDER BY timestamp ASC, rowid ASC
              LIMIT ? OFFSET ?
            `,
          )
          .all(
            skillOwner,
            skillName,
            version,
            page.limit + 1,
            page.offset,
          ) as AuditEventRow[]);

  return toPage(rows, page);
}

export class AuditSkillOwnerScopeUnavailableError extends Error {
  constructor() {
    super('audit_events.skill_owner is required for scoped audit lookups');
    this.name = 'AuditSkillOwnerScopeUnavailableError';
  }
}

export function hasAuditSkillOwnerColumn(db: Database.Database): boolean {
  const columns = db.pragma('table_info(audit_events)') as Array<{ name: string }>;
  return columns.some((column) => column.name === 'skill_owner');
}

function assertAuditSkillOwnerScoped(db: Database.Database): void {
  if (!hasAuditSkillOwnerColumn(db)) {
    throw new AuditSkillOwnerScopeUnavailableError();
  }
}

export function getByUser(
  db: Database.Database,
  actor: string,
  options: AuditEventPageOptions = {},
): AuditEventPage {
  const page = normalizePageOptions(options);
  const rows = db
    .prepare(
      `
        SELECT ${SELECT_COLUMNS}
        FROM audit_events
        WHERE actor = ?
        ORDER BY timestamp ASC, rowid ASC
        LIMIT ? OFFSET ?
      `,
    )
    .all(actor, page.limit + 1, page.offset) as AuditEventRow[];

  return toPage(rows, page);
}

export function getAllChronological(
  db: Database.Database,
  options: AuditEventPageOptions = {},
): AuditEventPage {
  const page = normalizePageOptions(options);
  const rows = db
    .prepare(
      `
        SELECT ${SELECT_COLUMNS}
        FROM audit_events
        ORDER BY timestamp ASC, rowid ASC
        LIMIT ? OFFSET ?
      `,
    )
    .all(page.limit + 1, page.offset) as AuditEventRow[];

  return toPage(rows, page);
}

function normalizePageOptions(options: AuditEventPageOptions): {
  limit: number;
  offset: number;
} {
  const limit =
    typeof options.limit === 'number' && Number.isFinite(options.limit)
      ? Math.trunc(options.limit)
      : DEFAULT_LIMIT;
  const offset =
    typeof options.offset === 'number' && Number.isFinite(options.offset)
      ? Math.trunc(options.offset)
      : 0;

  return {
    limit: Math.min(Math.max(limit, 1), MAX_LIMIT),
    offset: Math.min(Math.max(offset, 0), MAX_OFFSET),
  };
}

function toPage(
  rows: AuditEventRow[],
  page: { limit: number; offset: number },
): AuditEventPage {
  const pageRows = rows.slice(0, page.limit);
  return {
    items: pageRows.map(mapAuditEventRow),
    nextOffset: rows.length > page.limit ? page.offset + page.limit : null,
  };
}
