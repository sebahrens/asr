import type Database from 'better-sqlite3';
import { ulid } from 'ulid';
import { AUDIT_ACTIONS, type AuditAction, type AuditEvent } from '@asr/core';
import { AUDIT_HASH_FORMAT_VERSION, computeHash } from './hash.js';
import { loadKeyRing, type KeyRing } from './keyring.js';
import { ownerFromPrincipal } from '../identity/owners.js';

export interface EmitAuditInput {
  action: AuditAction;
  submissionId?: string | null;
  skillOwner?: string | null;
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
  keys: KeyRing = loadKeyRing(),
): AuditEvent {
  if (!(AUDIT_ACTIONS as readonly string[]).includes(input.action)) {
    throw new Error(`unknown audit action: ${input.action}`);
  }

  assertNoPii(input.detail);

  const keyId = keys.activeId;
  const hmacKey = keys.get(keyId);
  if (!hmacKey) {
    throw new Error(
      `audit KeyRing has no bytes for active key id '${keyId}'`,
    );
  }

  const id = ulid();
  const timestamp = new Date().toISOString();
  const skillOwner = resolveSkillOwner(db, input);

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

  const hash = computeHash(
    { ...unsigned, hashVersion: AUDIT_HASH_FORMAT_VERSION },
    hmacKey,
  );

  db.prepare(
    `
      INSERT INTO audit_events (
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
        hmac_key_id,
        hash_version
      ) VALUES (
        @id,
        @submissionId,
        @skillOwner,
        @skillName,
        @version,
        @timestamp,
        @actor,
        @actorType,
        @action,
        @detail,
        @prevHash,
        @hash,
        @hmacKeyId,
        @hashVersion
      )
    `,
  ).run({
    id,
    submissionId: unsigned.submissionId,
    skillOwner,
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
    hashVersion: AUDIT_HASH_FORMAT_VERSION,
  });

  return { ...unsigned, hash };
}

function resolveSkillOwner(
  db: Database.Database,
  input: EmitAuditInput,
): string | null {
  if (input.skillOwner !== undefined) {
    return input.skillOwner;
  }

  if (input.submissionId) {
    const submittedBy = db
      .prepare('SELECT submitted_by FROM submissions WHERE id = ?')
      .pluck()
      .get(input.submissionId) as string | undefined;
    if (submittedBy) {
      return ownerFromPrincipal(submittedBy);
    }
  }

  if (input.skillName && input.version) {
    const owner = db
      .prepare(
        `
          SELECT owner
          FROM skill_versions
          WHERE skill_name = ? AND version = ?
          ORDER BY published_at DESC
          LIMIT 1
        `,
      )
      .pluck()
      .get(input.skillName, input.version) as string | undefined;
    return owner ?? null;
  }

  return null;
}
