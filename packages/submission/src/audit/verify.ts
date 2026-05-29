import type Database from 'better-sqlite3';
import type { AuditEvent } from '@asr/core';
import { computeHash } from './hash.js';
import type { KeyRing } from './keyring.js';

export type VerifyResult =
  | {
      valid: true;
      eventCount: number;
      lastHash: string;
      lastHmacKeyId: string | null;
    }
  | {
      valid: false;
      brokenAt: string;
      reason: 'prev_hash mismatch' | 'unknown key' | 'hash mismatch';
    };

interface AuditEventRow {
  id: string;
  submission_id: string | null;
  skill_name: string | null;
  version: string | null;
  timestamp: string;
  actor: string;
  actor_type: 'user' | 'system' | 'compliance';
  action: string;
  detail: string;
  prev_hash: string;
  hash: string;
  hmac_key_id: string;
}

function rowToUnsignedEvent(row: AuditEventRow): Omit<AuditEvent, 'hash'> {
  return {
    id: row.id,
    submissionId: row.submission_id,
    skillName: row.skill_name,
    version: row.version,
    timestamp: row.timestamp,
    actor: row.actor,
    actorType: row.actor_type,
    action: row.action as AuditEvent['action'],
    detail: JSON.parse(row.detail) as Record<string, unknown>,
    prevHash: row.prev_hash,
    hmacKeyId: row.hmac_key_id,
  };
}

export function verifyChain(
  db: Database.Database,
  keys: KeyRing,
): VerifyResult {
  const rows = db
    .prepare('SELECT * FROM audit_events ORDER BY rowid')
    .all() as AuditEventRow[];

  let expectedPrev = '0'.repeat(64);
  let eventCount = 0;
  let lastHmacKeyId: string | null = null;

  for (const row of rows) {
    if (row.prev_hash !== expectedPrev) {
      return { valid: false, brokenAt: row.id, reason: 'prev_hash mismatch' };
    }

    const key = keys.get(row.hmac_key_id);
    if (!key) {
      return { valid: false, brokenAt: row.id, reason: 'unknown key' };
    }

    const unsigned = rowToUnsignedEvent(row);
    if (computeHash(unsigned, key) !== row.hash) {
      return { valid: false, brokenAt: row.id, reason: 'hash mismatch' };
    }

    expectedPrev = row.hash;
    lastHmacKeyId = row.hmac_key_id;
    eventCount += 1;
  }

  return { valid: true, eventCount, lastHash: expectedPrev, lastHmacKeyId };
}
