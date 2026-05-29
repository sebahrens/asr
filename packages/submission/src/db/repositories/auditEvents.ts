import type { AuditAction, AuditEvent } from '@asr/core';
import type Database from 'better-sqlite3';

interface AuditEventRow {
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

export function mapAuditEventRow(row: AuditEventRow): AuditEvent {
  return {
    id: row.id,
    submissionId: row.submission_id,
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

export function getBySubmission(
  db: Database.Database,
  submissionId: string,
): AuditEvent[] {
  const rows = db
    .prepare(
      `
        SELECT ${SELECT_COLUMNS}
        FROM audit_events
        WHERE submission_id = ?
        ORDER BY timestamp ASC, rowid ASC
      `,
    )
    .all(submissionId) as AuditEventRow[];

  return rows.map(mapAuditEventRow);
}

export function getBySkill(
  db: Database.Database,
  skillOwner: string,
  skillName: string,
  version?: string,
): AuditEvent[] {
  assertAuditSkillOwnerScoped(db);

  const rows =
    version === undefined
      ? (db
          .prepare(
            `
              SELECT ${SELECT_COLUMNS}
              FROM audit_events
              WHERE skill_owner = ? AND skill_name = ?
              ORDER BY timestamp ASC, rowid ASC
            `,
          )
          .all(skillOwner, skillName) as AuditEventRow[])
      : (db
          .prepare(
            `
              SELECT ${SELECT_COLUMNS}
              FROM audit_events
              WHERE skill_owner = ? AND skill_name = ? AND version = ?
              ORDER BY timestamp ASC, rowid ASC
            `,
          )
          .all(skillOwner, skillName, version) as AuditEventRow[]);

  return rows.map(mapAuditEventRow);
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

export function getByUser(db: Database.Database, actor: string): AuditEvent[] {
  const rows = db
    .prepare(
      `
        SELECT ${SELECT_COLUMNS}
        FROM audit_events
        WHERE actor = ?
        ORDER BY timestamp ASC, rowid ASC
      `,
    )
    .all(actor) as AuditEventRow[];

  return rows.map(mapAuditEventRow);
}

export function getAllChronological(db: Database.Database): AuditEvent[] {
  const rows = db
    .prepare(
      `
        SELECT ${SELECT_COLUMNS}
        FROM audit_events
        ORDER BY timestamp ASC, rowid ASC
      `,
    )
    .all() as AuditEventRow[];

  return rows.map(mapAuditEventRow);
}
