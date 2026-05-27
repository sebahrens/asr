import type { SkillManifest } from '@asr/core';
import Database from 'better-sqlite3';
import { pino } from 'pino';
import { afterEach, describe, expect, it } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Identity } from '../../auth/types.js';
import { runMigrations } from '../../db/migrations/index.js';
import { insertSubmission } from '../../db/repositories/submissions.js';
import { MCP_ERROR, McpToolError } from '../errors.js';
import { createRateLimiter } from '../rateLimit.js';
import type { WrapToolHandlerDeps } from '../server.js';
import {
  registerRegistryInfo,
  registryInfoHandler,
} from './registryInfo.js';

function makeManifest(overrides: Partial<SkillManifest> = {}): SkillManifest {
  const base: SkillManifest = {
    name: 'x',
    version: '1.0.0',
    author: 'acme',
    description: 'Skill x',
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

interface SeedOptions {
  id: string;
  manifest: SkillManifest;
  submittedAt: string;
  publishedAt: string;
  yankedAt?: string;
  yankReason?: string;
}

function seedPublished(
  db: Database.Database,
  { id, manifest, submittedAt, publishedAt, yankedAt, yankReason }: SeedOptions,
): void {
  const status: Record<string, unknown> = {
    phase: 'published',
    publishedAt,
    mergeCommit: `merge-${id}`,
  };
  if (yankedAt) {
    status.yankedAt = yankedAt;
  }
  if (yankReason) {
    status.yankReason = yankReason;
  }
  insertSubmission(db, {
    id,
    manifestJson: JSON.stringify(manifest),
    classification: 'md-only',
    contentHash: `sha256:${id}`,
    submittedAt,
    submittedBy: 'submitter@example.com',
    prNumber: 42,
    statusPhase: 'published',
    statusJson: JSON.stringify(status),
  });
}

function extraFor(principal: Identity): unknown {
  return {
    authInfo: { extra: { principal } },
    sessionId: 'test-session',
  };
}

describe('registryInfoHandler', () => {
  let db: Database.Database | undefined;

  afterEach(() => {
    db?.close();
    db = undefined;
  });

  it('returns SkillDetail with full version list for an existing skill', () => {
    db = new Database(':memory:');
    runMigrations(db);

    seedPublished(db, {
      id: 's-1',
      manifest: makeManifest({ name: 'x', version: '1.0.0' }),
      submittedAt: '2026-05-24T10:00:00.000Z',
      publishedAt: '2026-05-24T10:05:00.000Z',
    });
    seedPublished(db, {
      id: 's-2',
      manifest: makeManifest({ name: 'x', version: '1.1.0' }),
      submittedAt: '2026-05-25T10:00:00.000Z',
      publishedAt: '2026-05-25T10:05:00.000Z',
    });

    const result = registryInfoHandler(
      db,
      { owner: 'acme', name: 'x' },
      extraFor({ sub: 'p1', roles: ['Submitter'] }),
    );

    expect(result.structuredContent.owner).toBe('acme');
    expect(result.structuredContent.name).toBe('x');
    expect(result.structuredContent.latestVersion).toBe('1.1.0');
    expect(result.structuredContent.versions).toHaveLength(2);
    expect(result.structuredContent.versions.map((v) => v.version)).toEqual([
      '1.1.0',
      '1.0.0',
    ]);
  });

  it('includes yanked versions, marked, in the version list', () => {
    db = new Database(':memory:');
    runMigrations(db);

    seedPublished(db, {
      id: 's-1',
      manifest: makeManifest({ name: 'x', version: '1.0.0' }),
      submittedAt: '2026-05-24T10:00:00.000Z',
      publishedAt: '2026-05-24T10:05:00.000Z',
      yankedAt: '2026-05-26T10:00:00.000Z',
      yankReason: 'CVE-2026-0001',
    });
    seedPublished(db, {
      id: 's-2',
      manifest: makeManifest({ name: 'x', version: '1.1.0' }),
      submittedAt: '2026-05-25T10:00:00.000Z',
      publishedAt: '2026-05-25T10:05:00.000Z',
    });

    const result = registryInfoHandler(
      db,
      { owner: 'acme', name: 'x' },
      extraFor({ sub: 'p1', roles: ['Submitter'] }),
    );

    const v100 = result.structuredContent.versions.find(
      (v) => v.version === '1.0.0',
    );
    expect(v100?.yanked).toBe(true);
    expect(v100?.yankReason).toBe('CVE-2026-0001');
  });

  it('throws resource_not_found (-32003) for a missing skill', () => {
    db = new Database(':memory:');
    runMigrations(db);

    let caught: unknown;
    try {
      registryInfoHandler(
        db,
        { owner: 'acme', name: 'does-not-exist' },
        extraFor({ sub: 'p1', roles: ['Submitter'] }),
      );
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(McpToolError);
    expect((caught as McpToolError).code).toBe(MCP_ERROR.resource_not_found);
  });

  it('throws insufficient_permissions (-32001) for a non-Submitter', () => {
    db = new Database(':memory:');
    runMigrations(db);

    let caught: unknown;
    try {
      registryInfoHandler(
        db,
        { owner: 'acme', name: 'x' },
        extraFor({ sub: 'p1', roles: ['Compliance'] }),
      );
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(McpToolError);
    expect((caught as McpToolError).code).toBe(
      MCP_ERROR.insufficient_permissions,
    );
  });

  it('throws authentication_required (-32002) when no principal is bound', () => {
    db = new Database(':memory:');
    runMigrations(db);

    let caught: unknown;
    try {
      registryInfoHandler(db, { owner: 'acme', name: 'x' }, {});
    } catch (err) {
      caught = err;
    }

    expect((caught as McpToolError).code).toBe(
      MCP_ERROR.authentication_required,
    );
  });
});

describe('registerRegistryInfo', () => {
  let db: Database.Database | undefined;

  afterEach(() => {
    db?.close();
    db = undefined;
  });

  it('registers registry_info on tools/list', () => {
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

    registerRegistryInfo(server, db, deps);

    const internal = server as unknown as {
      _registeredTools?: Record<string, { enabled?: boolean }>;
    };
    expect(internal._registeredTools?.registry_info).toBeDefined();
    expect(internal._registeredTools?.registry_info?.enabled).not.toBe(false);
  });
});
