import { Buffer } from 'node:buffer';
import type Database from 'better-sqlite3';
import { emitAudit } from './emit.js';

export interface KeyRing {
  readonly activeId: string;
  get(id: string): Buffer | undefined;
  addKey(id: string, bytes: Buffer): void;
  setActive(id: string): void;
}

const PREVIOUS_KEY_PREFIX = 'AUDIT_HMAC_KEY_BYTES_';

export class MissingAuditKeyMaterialError extends Error {
  constructor(readonly keyIds: string[]) {
    super(
      `missing audit HMAC key material for historical key id(s): ${keyIds.join(
        ', ',
      )}; restore AUDIT_HMAC_KEY_BYTES_<id> env vars for retired keys before startup`,
    );
    this.name = 'MissingAuditKeyMaterialError';
  }
}

export function loadKeyRing(
  env: NodeJS.ProcessEnv = process.env,
): KeyRing {
  const activeId = env.AUDIT_HMAC_KEY_ID;
  const activeB64 = env.AUDIT_HMAC_KEY_BYTES;

  if (!activeId || !activeB64) {
    throw new Error(
      'AUDIT_HMAC_KEY_ID and AUDIT_HMAC_KEY_BYTES must be set to load the audit KeyRing',
    );
  }

  const activeBytes = Buffer.from(activeB64, 'base64');
  if (activeBytes.length !== 32) {
    throw new Error(
      `AUDIT_HMAC_KEY_BYTES must decode to 32 bytes (got ${activeBytes.length})`,
    );
  }

  const keys = new Map<string, Buffer>();
  keys.set(activeId, activeBytes);

  for (const [name, value] of Object.entries(env)) {
    if (!name.startsWith(PREVIOUS_KEY_PREFIX) || !value) continue;
    const id = name.slice(PREVIOUS_KEY_PREFIX.length);
    if (!id || id === activeId) continue;
    keys.set(id, Buffer.from(value, 'base64'));
  }

  let currentActiveId = activeId;

  return {
    get activeId(): string {
      return currentActiveId;
    },
    get(id: string): Buffer | undefined {
      return keys.get(id);
    },
    addKey(id: string, bytes: Buffer): void {
      keys.set(id, bytes);
    },
    setActive(id: string): void {
      if (!keys.has(id)) {
        throw new Error(`cannot set active key: unknown key id '${id}'`);
      }
      currentActiveId = id;
    },
  };
}

export function assertRetainedAuditKeys(
  db: Database.Database,
  keys: KeyRing,
): void {
  const usedKeyIds = db
    .prepare('SELECT DISTINCT hmac_key_id FROM audit_events')
    .pluck()
    .all() as string[];
  const missingKeyIds = usedKeyIds.filter((id) => !keys.get(id));

  if (missingKeyIds.length > 0) {
    throw new MissingAuditKeyMaterialError(missingKeyIds);
  }
}

/**
 * Rotate the audit HMAC key.
 *
 * Per specs/audit.md (HMAC Key Management): a `key.rotated` event is appended
 * with both the old and new key ids, signed by the OLD key, then all new events
 * use the new key. The whole sequence runs in a single db.transaction so the
 * keyring mutation and the audit row land atomically.
 */
export function rotateKey(
  db: Database.Database,
  keys: KeyRing,
  newId: string,
  newBytes: Buffer,
): void {
  const oldKeyId = keys.activeId;
  db.transaction(() => {
    keys.addKey(newId, newBytes);
    emitAudit(
      db,
      {
        action: 'key.rotated',
        actor: 'system',
        actorType: 'system',
        detail: { oldKeyId, newKeyId: newId },
      },
      keys,
    );
    keys.setActive(newId);
  })();
}
