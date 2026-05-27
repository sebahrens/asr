import type { SkillManifest } from '@asr/core';
import Database from 'better-sqlite3';
import { pino } from 'pino';
import { afterEach, describe, expect, it } from 'vitest';
import type { Identity } from '../../auth/types.js';
import { runMigrations } from '../../db/migrations/index.js';
import { insertSubmission } from '../../db/repositories/submissions.js';
import { MCP_ERROR, McpToolError } from '../errors.js';
import { createRateLimiter } from '../rateLimit.js';
import type { WrapToolHandlerDeps } from '../server.js';
import {
  registerRegistryList,
  registryListHandler,
} from './registryList.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

function makeManifest(overrides: Partial<SkillManifest> = {}): SkillManifest {
  const base: SkillManifest = {
    name: 'x',
    version: '1.0.0',
    author: 'acme',
    description: 'Skill x 1.0.0',
    tags: ['automation'],
    kind: 'skill',
    permissions: {
      network: false,
      filesystem: 'none',
      subprocess: false,
      environment: [],
    },
  };
  return { ...base, ...overrides };
}

function seedPublished(
  db: Database.Database,
  id: string,
  manifest: SkillManifest,
  submittedAt: string,
  publishedAt: string,
): void {
  insertSubmission(db, {
    id,
    manifestJson: JSON.stringify(manifest),
    classification: 'md-only',
    contentHash: `sha256:${id}`,
    submittedAt,
    submittedBy: 'submitter@example.com',
    prNumber: 42,
    statusPhase: 'published',
    statusJson: JSON.stringify({
      phase: 'published',
      publishedAt,
      mergeCommit: `merge-${id}`,
    }),
  });
}

function extraFor(principal: Identity): unknown {
  return {
    authInfo: { extra: { principal } },
    sessionId: 'test-session',
  };
}

describe('registryListHandler', () => {
  let db: Database.Database | undefined;

  afterEach(() => {
    db?.close();
    db = undefined;
  });

  it('lists all published skills, newest first, for a Submitter', () => {
    db = new Database(':memory:');
    runMigrations(db);

    seedPublished(
      db,
      's-a',
      makeManifest({ name: 'a' }),
      '2026-05-24T10:00:00.000Z',
      '2026-05-24T10:05:00.000Z',
    );
    seedPublished(
      db,
      's-b',
      makeManifest({ name: 'b' }),
      '2026-05-25T10:00:00.000Z',
      '2026-05-25T10:05:00.000Z',
    );

    const result = registryListHandler(
      db,
      { limit: 20 },
      extraFor({ sub: 'p1', roles: ['Submitter'] }),
    );

    expect(result.structuredContent.skills.map((s) => s.name)).toEqual(['b', 'a']);
  });

  it('filters by kind', () => {
    db = new Database(':memory:');
    runMigrations(db);

    seedPublished(
      db,
      's-skill',
      makeManifest({ name: 'a', kind: 'skill' }),
      '2026-05-24T10:00:00.000Z',
      '2026-05-24T10:05:00.000Z',
    );
    seedPublished(
      db,
      's-persona',
      makeManifest({ name: 'b', kind: 'persona' }),
      '2026-05-25T10:00:00.000Z',
      '2026-05-25T10:05:00.000Z',
    );

    const result = registryListHandler(
      db,
      { kind: 'persona', limit: 20 },
      extraFor({ sub: 'p1', roles: ['Submitter'] }),
    );

    expect(result.structuredContent.skills.map((s) => s.name)).toEqual(['b']);
  });

  it('AND-matches multiple tags', () => {
    db = new Database(':memory:');
    runMigrations(db);

    seedPublished(
      db,
      's-1',
      makeManifest({ name: 'one', tags: ['automation', 'review'] }),
      '2026-05-24T10:00:00.000Z',
      '2026-05-24T10:05:00.000Z',
    );
    seedPublished(
      db,
      's-2',
      makeManifest({ name: 'two', tags: ['automation'] }),
      '2026-05-25T10:00:00.000Z',
      '2026-05-25T10:05:00.000Z',
    );

    const result = registryListHandler(
      db,
      { tag: ['automation', 'review'], limit: 20 },
      extraFor({ sub: 'p1', roles: ['Submitter'] }),
    );

    expect(result.structuredContent.skills.map((s) => s.name)).toEqual(['one']);
  });

  it('filters by author', () => {
    db = new Database(':memory:');
    runMigrations(db);

    seedPublished(
      db,
      's-a',
      makeManifest({ name: 'a', author: 'acme' }),
      '2026-05-24T10:00:00.000Z',
      '2026-05-24T10:05:00.000Z',
    );
    seedPublished(
      db,
      's-b',
      makeManifest({ name: 'b', author: 'corp' }),
      '2026-05-25T10:00:00.000Z',
      '2026-05-25T10:05:00.000Z',
    );

    const result = registryListHandler(
      db,
      { author: 'corp', limit: 20 },
      extraFor({ sub: 'p1', roles: ['Submitter'] }),
    );

    expect(result.structuredContent.skills.map((s) => s.name)).toEqual(['b']);
  });

  it('throws insufficient_permissions (-32001) for a principal lacking the Submitter role', () => {
    db = new Database(':memory:');
    runMigrations(db);

    let caught: unknown;
    try {
      registryListHandler(
        db,
        { limit: 20 },
        extraFor({ sub: 'p1', roles: ['Compliance'] }),
      );
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(McpToolError);
    expect((caught as McpToolError).code).toBe(MCP_ERROR.insufficient_permissions);
  });

  it('throws authentication_required (-32002) when no principal is bound to extra', () => {
    db = new Database(':memory:');
    runMigrations(db);

    let caught: unknown;
    try {
      registryListHandler(db, { limit: 20 }, {});
    } catch (err) {
      caught = err;
    }

    expect((caught as McpToolError).code).toBe(MCP_ERROR.authentication_required);
  });
});

describe('registerRegistryList', () => {
  let db: Database.Database | undefined;

  afterEach(() => {
    db?.close();
    db = undefined;
  });

  it('registers registry_list on tools/list', () => {
    db = new Database(':memory:');
    runMigrations(db);

    const server = new McpServer({ name: 'asr-test', version: '0.0.0' });
    const deps: WrapToolHandlerDeps = {
      limiter: createRateLimiter(),
      logger: pino({ level: 'silent' }),
      principalOf: (extra) =>
        (
          (extra as { authInfo?: { extra?: { principal?: Identity } } } | undefined)
            ?.authInfo?.extra?.principal?.sub
        ) ?? '',
      sessionOf: (extra) =>
        (extra as { sessionId?: string } | undefined)?.sessionId ?? '',
    };

    registerRegistryList(server, db, deps);

    const internal = server as unknown as {
      _registeredTools?: Record<string, { enabled?: boolean }>;
    };
    expect(internal._registeredTools?.registry_list).toBeDefined();
    expect(internal._registeredTools?.registry_list?.enabled).not.toBe(false);
  });
});
