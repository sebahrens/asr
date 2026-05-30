import type Database from 'better-sqlite3';
import type { MiddlewareHandler } from 'hono';
import { apiError } from '../http/errors.js';
import { emitAudit } from './emit.js';
import { assertRetainedAuditKeys, type KeyRing } from './keyring.js';
import { verifyChain, type VerifyResult } from './verify.js';

export interface AuditChainGuardOptions {
  /**
   * Cache TTL in ms for verifyChain results. 0 disables the cache.
   * Defaults to 1000ms — short enough that a manual DB tamper is detected
   * within a second, long enough that bursts of writes do not each re-walk
   * the audit_events table.
   */
  cacheMs?: number;
}

export function auditChainGuard(
  db: Database.Database,
  keys: KeyRing,
  options: AuditChainGuardOptions = {},
): MiddlewareHandler {
  assertRetainedAuditKeys(db, keys);

  const cacheMs = options.cacheMs ?? 1000;
  let cached: { result: VerifyResult; expiresAt: number } | null = null;
  let verifiedPrefix:
    | {
        rowid: number;
        eventCount: number;
        lastHash: string;
        lastHmacKeyId: string | null;
      }
    | null = null;

  function readVerifyResult(): VerifyResult {
    if (cacheMs > 0 && cached && cached.expiresAt > Date.now()) {
      return cached.result;
    }
    const result = verifiedPrefix
      ? verifyChain(db, keys, {
          startAfterRowid: verifiedPrefix.rowid,
          expectedPrevHash: verifiedPrefix.lastHash,
          initialEventCount: verifiedPrefix.eventCount,
        })
      : verifyChain(db, keys);

    if (result.valid) {
      const tail = readAuditTail();
      verifiedPrefix = {
        rowid: tail.rowid,
        eventCount: result.eventCount,
        lastHash: result.lastHash,
        lastHmacKeyId:
          result.lastHmacKeyId ?? verifiedPrefix?.lastHmacKeyId ?? null,
      };
    }

    if (cacheMs > 0) {
      cached = { result, expiresAt: Date.now() + cacheMs };
    } else {
      cached = null;
    }
    return result;
  }

  return async (c, next) => {
    const method = c.req.method.toUpperCase();
    if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') {
      await next();
      return;
    }

    if (!c.req.path.startsWith('/api/v1/')) {
      await next();
      return;
    }

    const result = readVerifyResult();
    if (result.valid) {
      await next();
      return;
    }

    const lastAction = db
      .prepare('SELECT action FROM audit_events ORDER BY rowid DESC LIMIT 1')
      .pluck()
      .get() as string | undefined;

    if (lastAction !== 'audit.verify.failed') {
      emitAudit(db, {
        action: 'audit.verify.failed',
        actor: 'system',
        actorType: 'system',
        detail: { brokenAt: result.brokenAt, reason: result.reason },
      });
    }

    return apiError(c, 503, 'audit_chain_broken', { brokenAt: result.brokenAt });
  };

  function readAuditTail(): { rowid: number } {
    const row = db
      .prepare('SELECT rowid FROM audit_events ORDER BY rowid DESC LIMIT 1')
      .get() as { rowid: number } | undefined;

    return { rowid: row?.rowid ?? 0 };
  }
}
