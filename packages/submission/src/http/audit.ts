import type Database from 'better-sqlite3';
import { Hono } from 'hono';
import type { AuthVariables, Identity } from '../auth/types.js';
import { requireRole } from '../auth/requireRole.js';
import { loadKeyRing, type KeyRing } from '../audit/keyring.js';
import { verifyChain } from '../audit/verify.js';
import { getBySkill, getBySubmission, getByUser } from '../db/repositories/auditEvents.js';
import { getSubmissionById } from '../db/repositories/submissions.js';
import { apiError } from './errors.js';
import { getDefaultRegistryDb } from './registry.js';

export interface AuditRouteOptions {
  db?: Database.Database;
  keys?: KeyRing | (() => KeyRing);
}

export function createAuditRoutes(options: AuditRouteOptions = {}) {
  const routes = new Hono<{ Variables: AuthVariables }>();
  const db = options.db ?? getDefaultRegistryDb();
  const resolveKeys = (): KeyRing => {
    if (!options.keys) return loadKeyRing();
    return typeof options.keys === 'function' ? options.keys() : options.keys;
  };

  routes.get(
    '/skill/:owner/:name',
    requireRole('Compliance', 'Admin'),
    (c) => c.json(getBySkill(db, c.req.param('name'))),
  );

  routes.get(
    '/skill/:owner/:name/v/:version',
    requireRole('Compliance', 'Admin'),
    (c) => c.json(getBySkill(db, c.req.param('name'), c.req.param('version'))),
  );

  routes.get(
    '/user/:sub',
    requireRole('Admin'),
    (c) => c.json(getByUser(db, c.req.param('sub'))),
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

    return c.json(getBySubmission(db, submissionId));
  });

  // TODO(asr-3f8): rate-limit this admin-only chain scan (specs/audit.md L189).
  routes.get(
    '/verify',
    requireRole('Admin'),
    (c) => c.json(verifyChain(db, resolveKeys())),
  );

  return routes;
}

export const auditRoutes = createAuditRoutes();
