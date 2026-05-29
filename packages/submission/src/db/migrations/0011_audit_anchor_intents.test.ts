import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { migration0011AuditAnchorIntents } from './0011_audit_anchor_intents.js';

describe('migration0011AuditAnchorIntents', () => {
  it('creates an idempotent audit anchor intent table keyed by tag name', () => {
    const db = new Database(':memory:');
    try {
      migration0011AuditAnchorIntents.up(db);
      migration0011AuditAnchorIntents.up(db);

      const columns = db.pragma('table_info(audit_anchor_intents)') as Array<{
        name: string;
        pk: number;
      }>;
      expect(columns.map((column) => column.name)).toEqual([
        'tag_name',
        'last_hash',
        'event_count',
        'hmac_key_id',
        'target_sha',
        'status',
        'commit_sha',
        'created_at',
        'updated_at',
      ]);
      expect(columns.find((column) => column.name === 'tag_name')?.pk).toBe(1);

      db.prepare(
        `
          INSERT INTO audit_anchor_intents (
            tag_name,
            last_hash,
            event_count,
            hmac_key_id,
            target_sha,
            status,
            created_at,
            updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `,
      ).run(
        'audit-anchor-abc-1',
        'abc',
        1,
        'k1',
        'main-sha',
        'pending',
        '2026-05-29T00:00:00.000Z',
        '2026-05-29T00:00:00.000Z',
      );

      expect(() => {
        db.prepare(
          `
            INSERT INTO audit_anchor_intents (
              tag_name,
              last_hash,
              event_count,
              hmac_key_id,
              target_sha,
              status,
              created_at,
              updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          `,
        ).run(
          'audit-anchor-abc-1',
          'abc',
          1,
          'k1',
          'main-sha',
          'pending',
          '2026-05-29T00:00:01.000Z',
          '2026-05-29T00:00:01.000Z',
        );
      }).toThrow();
    } finally {
      db.close();
    }
  });
});
