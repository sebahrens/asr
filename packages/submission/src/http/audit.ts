import type Database from 'better-sqlite3';
import { Hono } from 'hono';
import type { AuthVariables } from '../auth/types.js';
import { requireRole } from '../auth/requireRole.js';
import { loadKeyRing, type KeyRing } from '../audit/keyring.js';
import { verifyChain } from '../audit/verify.js';
import { getBySkill, getByUser } from '../db/repositories/auditEvents.js';
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

  // TODO(asr-3f8): rate-limit this admin-only chain scan (specs/audit.md L189).
  routes.get(
    '/verify',
    requireRole('Admin'),
    (c) => c.json(verifyChain(db, resolveKeys())),
  );

  return routes;
}

export const auditRoutes = createAuditRoutes();
