import type Database from 'better-sqlite3';
import { Hono } from 'hono';
import type { AuthVariables, Identity } from '../auth/types.js';
import { requireRole } from '../auth/requireRole.js';
import { loadKeyRing, type KeyRing } from '../audit/keyring.js';
import { verifyChain } from '../audit/verify.js';
import {
  AuditSkillOwnerScopeUnavailableError,
  getBySkill,
  getBySubmission,
  getByUser,
} from '../db/repositories/auditEvents.js';
import { getSubmissionById } from '../db/repositories/submissions.js';
import { createRateLimiter, type RateLimiter } from '../mcp/rateLimit.js';
import { apiError } from './errors.js';
import { getDefaultRegistryDb } from './registry.js';

export interface AuditRouteOptions {
  db?: Database.Database;
  keys?: KeyRing | (() => KeyRing);
  limiter?: RateLimiter;
}

const defaultAuditVerifyLimiter = createRateLimiter();

export function createAuditRoutes(options: AuditRouteOptions = {}) {
  const routes = new Hono<{ Variables: AuthVariables }>();
  const db = options.db ?? getDefaultRegistryDb();
  const limiter = options.limiter ?? defaultAuditVerifyLimiter;
  const resolveKeys = (): KeyRing => {
    if (!options.keys) return loadKeyRing();
    return typeof options.keys === 'function' ? options.keys() : options.keys;
  };

  routes.get(
    '/skill/:owner/:name',
    requireRole('Compliance', 'Admin'),
    (c) => {
      try {
        return c.json(
          toAuditPageResponse(
            getBySkill(
              db,
              c.req.param('owner'),
              c.req.param('name'),
              undefined,
              parsePageOptions(c.req.query('limit'), c.req.query('cursor')),
            ),
          ),
        );
      } catch (error) {
        if (error instanceof AuditSkillOwnerScopeUnavailableError) {
          return apiError(c, 503, 'audit_scope_unavailable');
        }
        throw error;
      }
    },
  );

  routes.get(
    '/skill/:owner/:name/v/:version',
    requireRole('Compliance', 'Admin'),
    (c) => {
      try {
        return c.json(
          getBySkill(
            db,
            c.req.param('owner'),
            c.req.param('name'),
            c.req.param('version'),
            parsePageOptions(c.req.query('limit'), c.req.query('cursor')),
          ),
        );
      } catch (error) {
        if (error instanceof AuditSkillOwnerScopeUnavailableError) {
          return apiError(c, 503, 'audit_scope_unavailable');
        }
        throw error;
      }
    },
  );

  routes.get(
    '/user/:sub',
    requireRole('Admin'),
    (c) =>
      c.json(
        toAuditPageResponse(
          getByUser(
            db,
            c.req.param('sub'),
            parsePageOptions(c.req.query('limit'), c.req.query('cursor')),
          ),
        ),
      ),
  );

  routes.get('/submission/:id', (c) => {
    const identity: Identity | undefined = c.get('identity');
    if (!identity) return apiError(c, 401, 'authentication_required');

    const submissionId = c.req.param('id');
    const row = getSubmissionById(db, submissionId);
    if (!row) return apiError(c, 404, 'submission_not_found');

    const isElevated =
      identity.roles.includes('Compliance') || identity.roles.includes('Admin');
    const isOwner = identity.sub === row.submitted_by;
    if (!isElevated && !isOwner) {
      return apiError(c, 403, 'insufficient_permissions');
    }

    return c.json(
      toAuditPageResponse(
        getBySubmission(
          db,
          submissionId,
          parsePageOptions(c.req.query('limit'), c.req.query('cursor')),
        ),
      ),
    );
  });

  routes.get(
    '/verify',
    requireRole('Admin'),
    (c) => {
      const identity = c.get('identity');
      const limit = limiter.check(identity.sub, 'audit_verify');
      if (!limit.ok) {
        c.header('Retry-After', String(limit.retryAfterSeconds));
        return apiError(c, 429, 'too_many_requests', {
          retryAfterSeconds: limit.retryAfterSeconds,
        });
      }

      return c.json(verifyChain(db, resolveKeys()));
    },
  );

  return routes;
}

function parsePageOptions(
  limitValue: string | undefined,
  cursorValue: string | undefined,
): { limit?: number; offset?: number } {
  return {
    limit: parseLimit(limitValue),
    offset: decodeCursor(cursorValue),
  };
}

function parseLimit(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  const limit = Number(value);
  if (!Number.isInteger(limit) || limit <= 0) {
    return undefined;
  }

  return Math.min(limit, 100);
}

function decodeCursor(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }

  try {
    const decoded = JSON.parse(Buffer.from(value, 'base64').toString('utf8')) as {
      offset?: unknown;
    };
    return isValidCursorOffset(decoded.offset) ? decoded.offset : undefined;
  } catch {
    return undefined;
  }
}

const MAX_CURSOR_OFFSET = 100_000;

function isValidCursorOffset(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 0 &&
    value < MAX_CURSOR_OFFSET
  );
}

function encodeCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ offset }), 'utf8').toString('base64');
}

function toAuditPageResponse<T>(page: { items: T[]; nextOffset: number | null }): {
  items: T[];
  nextCursor: string | null;
} {
  return {
    items: page.items,
    nextCursor: page.nextOffset === null ? null : encodeCursor(page.nextOffset),
  };
}
