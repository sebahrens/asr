import type { SkillManifest } from '@asr/core';
import Database from 'better-sqlite3';
import { pino } from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Identity } from '../../auth/types.js';
import { runMigrations } from '../../db/migrations/index.js';
import { insertSubmission } from '../../db/repositories/submissions.js';
import { MCP_ERROR, McpToolError } from '../errors.js';
import { createRateLimiter } from '../rateLimit.js';
import type { WrapToolHandlerDeps } from '../server.js';
import {
  registerRegistrySearch,
  registrySearchHandler,
} from './registrySearch.js';
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

describe('registrySearchHandler', () => {
  let db: Database.Database | undefined;

  afterEach(() => {
    db?.close();
    db = undefined;
  });

  it('returns SkillSummary entries matching a free-text query for a Submitter', () => {
    db = new Database(':memory:');
    runMigrations(db);

    seedPublished(
      db,
      's-x',
      makeManifest({ name: 'x' }),
      '2026-05-24T10:00:00.000Z',
      '2026-05-24T10:05:00.000Z',
    );
    seedPublished(
      db,
      's-y',
      makeManifest({ name: 'y', description: 'unrelated' }),
      '2026-05-24T11:00:00.000Z',
      '2026-05-24T11:05:00.000Z',
    );

    const result = registrySearchHandler(
      db,
      { query: 'x', limit: 20 },
      extraFor({ sub: 'p1', roles: ['Submitter'] }),
    );

    expect(result.structuredContent.skills).toHaveLength(1);
    expect(result.structuredContent.skills[0]).toMatchObject({
      owner: 'acme',
      name: 'x',
      latestVersion: '1.0.0',
      kind: 'skill',
      tags: ['automation'],
    });

    const parsed = JSON.parse(result.content[0]!.text) as {
      skills: Array<{ name: string }>;
    };
    expect(parsed.skills.map((s) => s.name)).toEqual(['x']);
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

    const result = registrySearchHandler(
      db,
      { tag: ['automation', 'review'], limit: 20 },
      extraFor({ sub: 'p1', roles: ['Submitter'] }),
    );

    expect(result.structuredContent.skills.map((s) => s.name)).toEqual(['one']);
  });

  it('filters by author (manifest.author == owner)', () => {
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

    const result = registrySearchHandler(
      db,
      { author: 'corp', limit: 20 },
      extraFor({ sub: 'p1', roles: ['Submitter'] }),
    );

    expect(result.structuredContent.skills.map((s) => s.name)).toEqual(['b']);
  });

  it('respects the limit', () => {
    db = new Database(':memory:');
    runMigrations(db);

    for (let i = 0; i < 3; i += 1) {
      seedPublished(
        db,
        `s-${i}`,
        makeManifest({ name: `n${i}` }),
        `2026-05-24T1${i}:00:00.000Z`,
        `2026-05-24T1${i}:05:00.000Z`,
      );
    }

    const result = registrySearchHandler(
      db,
      { limit: 2 },
      extraFor({ sub: 'p1', roles: ['Submitter'] }),
    );

    expect(result.structuredContent.skills).toHaveLength(2);
  });

  it('passes caller limit through to the repository before parsing result rows', () => {
    db = new Database(':memory:');
    runMigrations(db);

    for (let i = 0; i < 3; i += 1) {
      seedPublished(
        db,
        `s-${i}`,
        makeManifest({ name: `n${i}` }),
        `2026-05-24T1${i}:00:00.000Z`,
        `2026-05-24T1${i}:05:00.000Z`,
      );
    }
    const parse = JSON.parse;
    let parseCount = 0;
    const parseSpy = vi.spyOn(JSON, 'parse').mockImplementation((value) => {
      parseCount += 1;
      return parse(value);
    });

    try {
      registrySearchHandler(
        db,
        { limit: 2 },
        extraFor({ sub: 'p1', roles: ['Submitter'] }),
      );
      expect(parseCount).toBe(4);
    } finally {
      parseSpy.mockRestore();
    }
  });

  it('throws insufficient_permissions (-32001) for a principal lacking the Submitter role', () => {
    db = new Database(':memory:');
    runMigrations(db);

    let caught: unknown;
    try {
      registrySearchHandler(
        db,
        { limit: 20 },
        extraFor({ sub: 'p1', roles: ['Compliance'] }),
      );
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(McpToolError);
    expect((caught as McpToolError).code).toBe(MCP_ERROR.insufficient_permissions);
    expect((caught as McpToolError).code).toBe(-32001);
  });

  it('throws authentication_required (-32002) when no principal is bound to extra', () => {
    db = new Database(':memory:');
    runMigrations(db);

    let caught: unknown;
    try {
      registrySearchHandler(db, { limit: 20 }, {});
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(McpToolError);
    expect((caught as McpToolError).code).toBe(MCP_ERROR.authentication_required);
  });
});

describe('registerRegistrySearch', () => {
  let db: Database.Database | undefined;

  afterEach(() => {
    db?.close();
    db = undefined;
  });

  it('registers registry_search on tools/list', () => {
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

    registerRegistrySearch(server, db, deps);

    const internal = server as unknown as {
      _registeredTools?: Record<string, { enabled?: boolean }>;
    };
    expect(internal._registeredTools?.registry_search).toBeDefined();
    expect(internal._registeredTools?.registry_search?.enabled).not.toBe(false);
  });
});
