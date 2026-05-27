import type Database from 'better-sqlite3';
import type { MiddlewareHandler } from 'hono';
import { apiError } from '../http/errors.js';
import { emitAudit } from './emit.js';
import type { KeyRing } from './keyring.js';
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
  const cacheMs = options.cacheMs ?? 1000;
  let cached: { result: VerifyResult; expiresAt: number } | null = null;

  function readVerifyResult(): VerifyResult {
    if (cacheMs > 0 && cached && cached.expiresAt > Date.now()) {
      return cached.result;
    }
    const result = verifyChain(db, keys);
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
}
