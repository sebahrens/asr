import type Database from 'better-sqlite3';
import { ulid } from 'ulid';
import { AUDIT_ACTIONS, type AuditAction, type AuditEvent } from '@asr/core';
import { computeHash } from './hash.js';

export interface EmitAuditInput {
  action: AuditAction;
  submissionId?: string | null;
  skillName?: string | null;
  version?: string | null;
  actor: string;
  actorType: 'user' | 'system' | 'compliance';
  detail: Record<string, unknown>;
}

const PII_KEYS = [
  'email',
  'displayname',
  'name',
  'givenname',
  'surname',
  'upn',
];

function assertNoPii(detail: Record<string, unknown>): void {
  for (const k of Object.keys(detail)) {
    if (PII_KEYS.includes(k.toLowerCase())) {
      throw new Error(`audit detail must not contain PII key: ${k}`);
    }
  }
}

/**
 * Insert a hash-chained audit row.
 *
 * The CALLER is responsible for wrapping this call in a `db.transaction(...)`
 * together with the state mutation it documents — `emitAudit` does NOT open
 * its own transaction. This is what makes the audit row and the workflow row
 * land together or not at all (specs/audit.md, single-transaction invariant).
 *
 * The closed `AUDIT_ACTIONS` enum is enforced BEFORE any DB access so a bad
 * action string never reaches SQLite or perturbs the hash chain.
 */
export function emitAudit(
  db: Database.Database,
  input: EmitAuditInput,
): AuditEvent {
  if (!(AUDIT_ACTIONS as readonly string[]).includes(input.action)) {
    throw new Error(`unknown audit action: ${input.action}`);
  }

  assertNoPii(input.detail);

  const keyId = process.env.AUDIT_HMAC_KEY_ID;
  const keyBytesB64 = process.env.AUDIT_HMAC_KEY_BYTES;
  if (!keyId || !keyBytesB64) {
    throw new Error(
      'AUDIT_HMAC_KEY_ID and AUDIT_HMAC_KEY_BYTES must be set to emit audit events',
    );
  }
  const hmacKey = Buffer.from(keyBytesB64, 'base64');

  const id = ulid();
  const timestamp = new Date().toISOString();

  const prevRow = db
    .prepare('SELECT hash FROM audit_events ORDER BY rowid DESC LIMIT 1')
    .pluck()
    .get() as string | undefined;
  const prevHash = prevRow ?? '0'.repeat(64);

  const unsigned: Omit<AuditEvent, 'hash'> = {
    id,
    submissionId: input.submissionId ?? null,
    skillName: input.skillName ?? null,
    version: input.version ?? null,
    timestamp,
    actor: input.actor,
    actorType: input.actorType,
    action: input.action,
    detail: input.detail,
    prevHash,
    hmacKeyId: keyId,
  };

  const hash = computeHash(unsigned, hmacKey);

  db.prepare(
    `
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
      ) VALUES (
        @id,
        @submissionId,
        @skillName,
        @version,
        @timestamp,
        @actor,
        @actorType,
        @action,
        @detail,
        @prevHash,
        @hash,
        @hmacKeyId
      )
    `,
  ).run({
    id,
    submissionId: unsigned.submissionId,
    skillName: unsigned.skillName,
    version: unsigned.version,
    timestamp,
    actor: unsigned.actor,
    actorType: unsigned.actorType,
    action: unsigned.action,
    detail: JSON.stringify(unsigned.detail),
    prevHash,
    hash,
    hmacKeyId: keyId,
  });

  return { ...unsigned, hash };
}
