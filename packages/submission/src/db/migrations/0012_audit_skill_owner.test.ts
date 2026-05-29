import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { migration0012AuditSkillOwner } from './0012_audit_skill_owner.js';

describe('migration0012AuditSkillOwner', () => {
  let db: Database.Database | undefined;

  afterEach(() => {
    db?.close();
    db = undefined;
  });

  it('adds skill_owner and backfills it from matching skill_versions rows', () => {
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE audit_events (
        id TEXT PRIMARY KEY,
        submission_id TEXT,
        skill_name TEXT,
        version TEXT,
        timestamp TEXT NOT NULL,
        actor TEXT NOT NULL,
        actor_type TEXT NOT NULL,
        action TEXT NOT NULL,
        detail TEXT NOT NULL,
        prev_hash TEXT NOT NULL,
        hash TEXT NOT NULL,
        hmac_key_id TEXT NOT NULL
      );

      CREATE TABLE skill_versions (
        owner TEXT NOT NULL,
        skill_name TEXT NOT NULL,
        version TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        submission_id TEXT NOT NULL,
        published_at TEXT NOT NULL,
        published_by TEXT NOT NULL,
        approved_by TEXT,
        pr_number INTEGER NOT NULL,
        merge_commit TEXT NOT NULL,
        scan_report_id TEXT,
        yanked_at TEXT,
        yanked_by TEXT,
        yank_reason TEXT,
        PRIMARY KEY (owner, skill_name, version)
      );

      INSERT INTO audit_events (
        id,
        submission_id,
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
      ) VALUES
        ('evt_a', 'sub_a', 'foo', '1.0.0', '2026-05-29T00:00:00.000Z', 'alice', 'user', 'submission.created', '{}', '0', 'a', 'k'),
        ('evt_b', 'sub_b', 'foo', '1.0.0', '2026-05-29T00:00:01.000Z', 'bob', 'user', 'submission.created', '{}', 'a', 'b', 'k');

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
      ) VALUES
        ('owner-a', 'foo', '1.0.0', 'sha256:a', 'sub_a', '2026-05-29T00:00:02.000Z', 'alice', NULL, 1, 'abc', NULL, NULL, NULL, NULL),
        ('owner-b', 'foo', '1.0.0', 'sha256:b', 'sub_b', '2026-05-29T00:00:03.000Z', 'bob', NULL, 2, 'def', NULL, NULL, NULL, NULL);
    `);

    migration0012AuditSkillOwner.up(db);

    const columns = db.pragma('table_info(audit_events)') as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).toContain('skill_owner');

    const rows = db
      .prepare('SELECT id, skill_owner FROM audit_events ORDER BY id')
      .all() as Array<{ id: string; skill_owner: string | null }>;
    expect(rows).toEqual([
      { id: 'evt_a', skill_owner: 'owner-a' },
      { id: 'evt_b', skill_owner: 'owner-b' },
    ]);
  });
});
