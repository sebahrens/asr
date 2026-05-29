import type { SkillManifest } from '@asr/core';
import Database from 'better-sqlite3';
import { pino } from 'pino';
import { afterEach, describe, expect, it } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Identity } from '../../auth/types.js';
import { runMigrations } from '../../db/migrations/index.js';
import { insertSkillVersion } from '../../db/repositories/skillVersions.js';
import { insertSubmission } from '../../db/repositories/submissions.js';
import { MCP_ERROR, McpToolError } from '../errors.js';
import { createRateLimiter } from '../rateLimit.js';
import type { WrapToolHandlerDeps } from '../server.js';
import {
  registerRegistryVersions,
  registryVersionsHandler,
} from './registryVersions.js';

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

  if (yankedAt) {
    insertSkillVersion(db, {
      skill_name: manifest.name,
      version: manifest.version,
      content_hash: `sha256:${id}`,
      submission_id: id,
      published_at: publishedAt,
      published_by: 'submitter@example.com',
      approved_by: null,
      pr_number: 42,
      merge_commit: `merge-${id}`,
      scan_report_id: null,
      yanked_at: yankedAt,
      yanked_by: 'compliance@example.com',
      yank_reason: yankReason ?? null,
    });
  }
}

function extraFor(principal: Identity): unknown {
  return {
    authInfo: { extra: { principal } },
    sessionId: 'test-session',
  };
}

describe('registryVersionsHandler', () => {
  let db: Database.Database | undefined;

  afterEach(() => {
    db?.close();
    db = undefined;
  });

  it('returns non-yanked versions only, semver-rsorted', () => {
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
    seedPublished(db, {
      id: 's-3',
      manifest: makeManifest({ name: 'x', version: '1.0.1' }),
      submittedAt: '2026-05-26T10:00:00.000Z',
      publishedAt: '2026-05-26T10:05:00.000Z',
      yankedAt: '2026-05-26T11:00:00.000Z',
      yankReason: 'CVE-2026-0001',
    });

    const result = registryVersionsHandler(
      db,
      { owner: 'acme', name: 'x' },
      extraFor({ sub: 'p1', roles: ['Submitter'] }),
    );

    expect(result.structuredContent.versions.map((v) => v.version)).toEqual([
      '1.1.0',
      '1.0.0',
    ]);
  });

  it('throws resource_not_found (-32003) for a missing skill', () => {
    db = new Database(':memory:');
    runMigrations(db);

    let caught: unknown;
    try {
      registryVersionsHandler(
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
      registryVersionsHandler(
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
      registryVersionsHandler(db, { owner: 'acme', name: 'x' }, {});
    } catch (err) {
      caught = err;
    }

    expect((caught as McpToolError).code).toBe(
      MCP_ERROR.authentication_required,
    );
  });
});

describe('registerRegistryVersions', () => {
  let db: Database.Database | undefined;

  afterEach(() => {
    db?.close();
    db = undefined;
  });

  it('registers registry_versions on tools/list', () => {
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

    registerRegistryVersions(server, db, deps);

    const internal = server as unknown as {
      _registeredTools?: Record<string, { enabled?: boolean }>;
    };
    expect(internal._registeredTools?.registry_versions).toBeDefined();
    expect(internal._registeredTools?.registry_versions?.enabled).not.toBe(false);
  });
});
