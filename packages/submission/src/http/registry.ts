import type { SkillKind } from '@asr/core';
import BetterSqlite3 from 'better-sqlite3';
import type Database from 'better-sqlite3';
import { Hono } from 'hono';
import { openDb } from '../db/index.js';
import { runMigrations } from '../db/migrations/index.js';
import { emitAudit, type EmitAuditInput } from '../audit/emit.js';
import { getPublishedSkill, getPublishedSkillVersion, listPublishedSkills } from '../db/repositories/skills.js';
import { getBlockedHash } from '../db/repositories/versions.js';
import { findDevRegistryDiff, seedDevRegistryDb } from './dev-seed.js';
import { apiError } from './errors.js';

export interface RegistryRouteOptions {
  db?: Database.Database;
  forgejoUrl?: string;
  emitAudit?: (input: EmitAuditInput) => void;
}

let defaultRegistryDb: Database.Database | undefined;

export function getDefaultRegistryDb(): Database.Database {
  defaultRegistryDb ??= createDefaultRegistryDb();
  return defaultRegistryDb;
}

export function createRegistryRoutes(options: RegistryRouteOptions = {}) {
  const routes = new Hono();
  const db = options.db ?? getDefaultRegistryDb();
  const forgejoUrl = options.forgejoUrl ?? process.env.FORGEJO_URL ?? 'http://forgejo:3000';
  const audit = options.emitAudit ?? ((input: EmitAuditInput) => emitAudit(db, input));

  routes.get('/', (c) => {
    const limit = parseLimit(c.req.query('limit'));
    const offset = decodeCursor(c.req.query('cursor'));
    const result = listPublishedSkills(db, {
      q: c.req.query('q'),
      tag: c.req.query('tag'),
      kind: parseKind(c.req.query('kind')),
      limit,
      offset,
    });

    c.header('Cache-Control', 'public, max-age=60');
    return c.json({
      items: result.items,
      nextCursor: result.nextOffset === null ? null : encodeCursor(result.nextOffset),
    });
  });

  routes.get('/:owner/:name', (c) => {
    const owner = c.req.param('owner');
    const name = c.req.param('name');
    const skill = getPublishedSkill(db, owner, name);
    if (!skill) {
      return apiError(c, 404, 'submission_not_found');
    }

    c.header('Cache-Control', 'public, max-age=60');
    return c.json(skill);
  });

  routes.get('/:owner/:name/v/:version', (c) => {
    const resolved = getPublishedSkillVersion(
      db,
      c.req.param('owner'),
      c.req.param('name'),
      c.req.param('version'),
    );
    if (!resolved) {
      return apiError(c, 404, 'submission_not_found');
    }

    if (resolved.skillVersion.yanked) {
      c.header('Cache-Control', 'no-store');
      return apiError(c, 410, 'version_yanked', {
        details: {
          owner: c.req.param('owner'),
          name: c.req.param('name'),
          version: c.req.param('version'),
        },
      });
    }

    const blockedHash = getBlockedHash(db, resolved.skillVersion.contentHash);
    if (blockedHash) {
      c.header('Cache-Control', 'no-store');
      return apiError(c, 410, 'content_blocked', {
        details: {
          owner: c.req.param('owner'),
          name: c.req.param('name'),
          version: c.req.param('version'),
        },
      });
    }

    c.header('Cache-Control', 'public, max-age=60');
    return c.json({
      manifest: resolved.manifest,
      skillMd: resolved.skillMd,
      version: resolved.skillVersion,
    });
  });

  routes.get('/:owner/:name/v/:version/download', (c) => {
    const owner = c.req.param('owner');
    const name = c.req.param('name');
    const version = c.req.param('version');
    const skill = getPublishedSkill(db, owner, name);
    const publishedVersion = skill?.versions.find((candidate) => candidate.version === version);
    if (!publishedVersion) {
      return apiError(c, 404, 'submission_not_found');
    }

    if (publishedVersion.yanked) {
      auditDownloadRefusal(audit, {
        owner,
        name,
        version,
        contentHash: publishedVersion.contentHash,
        reason: 'yanked',
      });
      c.header('Cache-Control', 'no-store');
      return apiError(c, 410, 'version_yanked', {
        details: { owner, name, version },
      });
    }

    const blockedHash = getBlockedHash(db, publishedVersion.contentHash);
    if (blockedHash) {
      auditDownloadRefusal(audit, {
        owner,
        name,
        version,
        contentHash: publishedVersion.contentHash,
        reason: 'blocked_hash',
        blockedSource: blockedHash.source,
      });
      c.header('Cache-Control', 'no-store');
      return apiError(c, 410, 'content_blocked', {
        details: { owner, name, version },
      });
    }

    return c.redirect(forgejoPackageUrl(forgejoUrl, owner, name, version), 302);
  });

  routes.get('/:owner/:name/versions', (c) => {
    const skill = getPublishedSkill(db, c.req.param('owner'), c.req.param('name'));
    if (!skill) {
      return apiError(c, 404, 'submission_not_found');
    }

    c.header('Cache-Control', 'public, max-age=60');
    return c.json(skill.versions.filter((version) => !version.yanked));
  });

  routes.get('/:owner/:name/versions/:version/diff', (c) => {
    const skill = getPublishedSkill(db, c.req.param('owner'), c.req.param('name'));
    if (!skill || !skill.versions.some((version) => version.version === c.req.param('version'))) {
      return apiError(c, 404, 'skill_not_found');
    }

    const diff = findDevRegistryDiff(skill.name, c.req.param('version'));
    if (!diff) {
      return apiError(c, 404, 'version_diff_not_found');
    }

    c.header('Cache-Control', 'public, max-age=60');
    return c.json(diff);
  });

  return routes;
}

function auditDownloadRefusal(
  audit: (input: EmitAuditInput) => void,
  input: {
    owner: string;
    name: string;
    version: string;
    contentHash: string;
    reason: 'yanked' | 'blocked_hash';
    blockedSource?: string;
  },
): void {
  audit({
    action: 'download.refused',
    skillOwner: input.owner,
    skillName: input.name,
    version: input.version,
    actor: 'system',
    actorType: 'system',
    detail: {
      owner: input.owner,
      contentHash: input.contentHash,
      reason: input.reason,
      ...(input.blockedSource ? { blockedSource: input.blockedSource } : {}),
    },
  });
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

function parseKind(value: string | undefined): SkillKind | undefined {
  return value === 'skill' || value === 'persona' ? value : undefined;
}

function decodeCursor(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }

  try {
    const decoded = JSON.parse(Buffer.from(value, 'base64').toString('utf8')) as { offset?: unknown };
    return isValidCursorOffset(decoded.offset) ? decoded.offset : undefined;
  } catch {
    return undefined;
  }
}

const MAX_CURSOR_OFFSET = 100_000;

function isValidCursorOffset(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value < MAX_CURSOR_OFFSET;
}

function encodeCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ offset }), 'utf8').toString('base64');
}

function forgejoPackageUrl(forgejoUrl: string, owner: string, name: string, version: string): string {
  const base = forgejoUrl.replace(/\/api\/v1\/?$/, '').replace(/\/$/, '');
  return `${base}/api/packages/${owner}/generic/${name}/${version}/skill.zip`;
}

function createDefaultRegistryDb(): Database.Database {
  if (process.env.NODE_ENV === 'production' && !process.env.DATABASE_PATH) {
    throw new Error('DATABASE_PATH is required in production');
  }

  const db = process.env.DATABASE_PATH ? openDb(process.env.DATABASE_PATH) : new BetterSqlite3(':memory:');
  runMigrations(db);

  if (process.env.NODE_ENV === 'development' && process.env.AUTH_MODE === 'mock') {
    seedDevRegistryDb(db);
  }

  return db;
}
