import { isValidSkillIdentifier, isValidSkillVersion, type ForgejoClient } from '@asr/core';
import type Database from 'better-sqlite3';
import { Hono } from 'hono';
import { requireRole } from '../auth/requireRole.js';
import { SeparationOfDutiesError, assertSeparation } from '../auth/separation.js';
import type { AuthVariables } from '../auth/types.js';
import { emitAudit } from '../audit/emit.js';
import {
  getSkillVersion,
  markVersionYanked,
} from '../db/repositories/skillVersions.js';
import { insertBlockedHash } from '../db/repositories/versions.js';
import { forgejoFromEnv } from '../forgejo/index.js';
import { apiError } from './errors.js';

export interface YankRouteOptions {
  db?: Database.Database;
  forgejo?: ForgejoClient;
  now?: () => Date;
  triggerMarketplaceSync?: (skillName: string) => Promise<void>;
}

const SEVERITIES = ['low', 'high', 'critical'] as const;
type Severity = (typeof SEVERITIES)[number];

interface YankBody {
  reason: string;
  severity: Severity;
}

export function createYankRoutes(options: YankRouteOptions = {}) {
  const routes = new Hono<{ Variables: AuthVariables }>();
  const now = options.now ?? (() => new Date());

  routes.post('/:owner/:name/versions/:version/yank', requireRole('Compliance'), async (c) => {
    const identity = c.get('identity')!;
    const body = await parseBody(c.req.raw);
    if (!body) {
      return apiError(c, 400, 'invalid_manifest', {
        message: 'reason (>=1) and severity (low|high|critical) are required',
      });
    }

    const db = options.db;
    if (!db) {
      return apiError(c, 500, 'internal_error', { message: 'database is not configured' });
    }

    const owner = c.req.param('owner');
    const name = c.req.param('name');
    const version = c.req.param('version');
    if (
      !isValidSkillIdentifier(owner) ||
      !isValidSkillIdentifier(name) ||
      !isValidSkillVersion(version)
    ) {
      return apiError(c, 422, 'invalid_manifest', {
        message: 'owner, name, and version path parameters must be valid skill identifiers',
      });
    }

    const row = getSkillVersion(db, name, version, owner);
    if (!row) {
      return apiError(c, 404, 'submission_not_found');
    }

    try {
      assertSeparation(row.published_by, identity.sub);
    } catch (err) {
      if (err instanceof SeparationOfDutiesError) {
        return apiError(c, 403, 'separation_of_duties_violation');
      }
      throw err;
    }

    if (row.yanked_at !== null) {
      return apiError(c, 409, 'version_yanked', {
        details: { name, version },
      });
    }

    const yankedAt = now().toISOString();

    db.transaction(() => {
      markVersionYanked(
        db,
        name,
        version,
        {
          yankedAt,
          yankedBy: identity.sub,
          reason: body.reason,
        },
        owner,
      );
      insertBlockedHash(db, {
        content_hash: row.content_hash,
        skill_name: name,
        version,
        blocked_at: yankedAt,
        blocked_by: identity.sub,
        reason: body.reason,
        source: 'yanked',
      });
      emitAudit(db, {
        action: 'version.yanked',
        skillOwner: owner,
        skillName: name,
        version,
        actor: identity.sub,
        actorType: 'compliance',
        detail: { reason: body.reason, severity: body.severity },
      });
    })();

    const forgejo = options.forgejo ?? forgejoFromEnv();
    await forgejo.commitFileToMain({
      owner,
      name,
      path: `skills/${owner}/${name}/YANKED.md`,
      content: Buffer.from(`# Yanked ${version}\n${body.reason}\n`),
      message: `yank ${name}@${version}`,
      idempotencyKey: `yank-${name}-${version}`,
    });

    if (options.triggerMarketplaceSync) {
      try {
        await options.triggerMarketplaceSync(name);
      } catch {
        // runMarketplaceSync already emits marketplace_sync.failed and pages;
        // a sync failure must not roll back the yank (specs/cli-integration.md#sync-job).
      }
    }

    return c.json({ yanked: true, blocked_hash: row.content_hash }, 201);
  });

  return routes;
}

async function parseBody(request: Request): Promise<YankBody | undefined> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return undefined;
  }

  if (typeof raw !== 'object' || raw === null) {
    return undefined;
  }

  const candidate = raw as { reason?: unknown; severity?: unknown };
  if (typeof candidate.reason !== 'string' || candidate.reason.length < 1) {
    return undefined;
  }
  if (
    typeof candidate.severity !== 'string' ||
    !(SEVERITIES as readonly string[]).includes(candidate.severity)
  ) {
    return undefined;
  }

  return { reason: candidate.reason, severity: candidate.severity as Severity };
}

export const yankRoutes = createYankRoutes();
