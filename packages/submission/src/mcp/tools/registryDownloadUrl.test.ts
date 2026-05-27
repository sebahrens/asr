import type { SkillManifest } from '@asr/core';
import Database from 'better-sqlite3';
import { pino } from 'pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Identity } from '../../auth/types.js';
import { runMigrations } from '../../db/migrations/index.js';
import { insertSubmission } from '../../db/repositories/submissions.js';
import { MCP_ERROR, McpToolError } from '../errors.js';
import { createRateLimiter } from '../rateLimit.js';
import type { WrapToolHandlerDeps } from '../server.js';
import {
  registerRegistryDownloadUrl,
  registryDownloadUrlHandler,
} from './registryDownloadUrl.js';

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
  contentHash?: string;
  yankedAt?: string;
  yankReason?: string;
}

function seedPublished(
  db: Database.Database,
  { id, manifest, submittedAt, publishedAt, contentHash, yankedAt, yankReason }: SeedOptions,
): void {
  const status: Record<string, unknown> = {
    phase: 'published',
    publishedAt,
    mergeCommit: `merge-${id}`,
  };
  if (yankedAt) status.yankedAt = yankedAt;
  if (yankReason) status.yankReason = yankReason;
  insertSubmission(db, {
    id,
    manifestJson: JSON.stringify(manifest),
    classification: 'md-only',
    contentHash: contentHash ?? `sha256:${id}`,
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

describe('registryDownloadUrlHandler', () => {
  let db: Database.Database | undefined;
  let originalForgejoUrl: string | undefined;

  beforeEach(() => {
    originalForgejoUrl = process.env.FORGEJO_URL;
    process.env.FORGEJO_URL = 'https://forgejo.example.test/api/v1';
  });

  afterEach(() => {
    db?.close();
    db = undefined;
    if (originalForgejoUrl === undefined) {
      delete process.env.FORGEJO_URL;
    } else {
      process.env.FORGEJO_URL = originalForgejoUrl;
    }
  });

  it('resolves an exact published version to a forgejo package URL', () => {
    db = new Database(':memory:');
    runMigrations(db);

    seedPublished(db, {
      id: 's-1',
      manifest: makeManifest({ version: '1.0.0' }),
      submittedAt: '2026-05-24T10:00:00.000Z',
      publishedAt: '2026-05-24T10:05:00.000Z',
      contentHash: 'sha256:abc',
    });

    const result = registryDownloadUrlHandler(
      db,
      { owner: 'acme', name: 'x', version: '1.0.0' },
      extraFor({ sub: 'p1', roles: ['Submitter'] }),
    );

    expect(result.structuredContent.url).toBe(
      'https://forgejo.example.test/api/packages/acme/generic/x/1.0.0/skill.zip',
    );
    expect(result.structuredContent.contentHash).toBe('sha256:abc');
    expect(result.structuredContent.manifest.version).toBe('1.0.0');
    expect(result.structuredContent.expiresAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(result.structuredContent.sizeBytes).toBe(0);
    expect(result.content[0]?.text).toContain(
      'https://forgejo.example.test/api/packages/acme/generic/x/1.0.0/skill.zip',
    );
  });

  it('defaults to the latest non-yanked version when version is omitted', () => {
    db = new Database(':memory:');
    runMigrations(db);

    seedPublished(db, {
      id: 's-1',
      manifest: makeManifest({ version: '1.0.0' }),
      submittedAt: '2026-05-24T10:00:00.000Z',
      publishedAt: '2026-05-24T10:05:00.000Z',
    });
    seedPublished(db, {
      id: 's-2',
      manifest: makeManifest({ version: '1.1.0' }),
      submittedAt: '2026-05-25T10:00:00.000Z',
      publishedAt: '2026-05-25T10:05:00.000Z',
    });
    seedPublished(db, {
      id: 's-3',
      manifest: makeManifest({ version: '1.2.0' }),
      submittedAt: '2026-05-26T10:00:00.000Z',
      publishedAt: '2026-05-26T10:05:00.000Z',
      yankedAt: '2026-05-26T11:00:00.000Z',
      yankReason: 'CVE-2026-0001',
    });

    const result = registryDownloadUrlHandler(
      db,
      { owner: 'acme', name: 'x' },
      extraFor({ sub: 'p1', roles: ['Submitter'] }),
    );

    expect(result.structuredContent.manifest.version).toBe('1.1.0');
    expect(result.structuredContent.url).toBe(
      'https://forgejo.example.test/api/packages/acme/generic/x/1.1.0/skill.zip',
    );
  });

  it('strips trailing slash from FORGEJO_URL when no /api/v1 suffix is present', () => {
    process.env.FORGEJO_URL = 'http://forgejo.local:3000/';
    db = new Database(':memory:');
    runMigrations(db);
    seedPublished(db, {
      id: 's-1',
      manifest: makeManifest({ version: '1.0.0' }),
      submittedAt: '2026-05-24T10:00:00.000Z',
      publishedAt: '2026-05-24T10:05:00.000Z',
    });

    const result = registryDownloadUrlHandler(
      db,
      { owner: 'acme', name: 'x', version: '1.0.0' },
      extraFor({ sub: 'p1', roles: ['Submitter'] }),
    );

    expect(result.structuredContent.url).toBe(
      'http://forgejo.local:3000/api/packages/acme/generic/x/1.0.0/skill.zip',
    );
  });

  it('throws version_yanked (-32004) when the resolved version is yanked', () => {
    db = new Database(':memory:');
    runMigrations(db);

    seedPublished(db, {
      id: 's-1',
      manifest: makeManifest({ version: '0.9.0' }),
      submittedAt: '2026-05-22T10:00:00.000Z',
      publishedAt: '2026-05-22T10:05:00.000Z',
      yankedAt: '2026-05-22T11:00:00.000Z',
      yankReason: 'CVE-2026-0001',
    });

    let caught: unknown;
    try {
      registryDownloadUrlHandler(
        db,
        { owner: 'acme', name: 'x', version: '0.9.0' },
        extraFor({ sub: 'p1', roles: ['Submitter'] }),
      );
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(McpToolError);
    expect((caught as McpToolError).code).toBe(MCP_ERROR.version_yanked);
    expect((caught as McpToolError).data).toMatchObject({
      owner: 'acme',
      name: 'x',
      version: '0.9.0',
      yankReason: 'CVE-2026-0001',
    });
  });

  it('throws resource_not_found (-32003) when the skill is unknown', () => {
    db = new Database(':memory:');
    runMigrations(db);

    let caught: unknown;
    try {
      registryDownloadUrlHandler(
        db,
        { owner: 'acme', name: 'nope' },
        extraFor({ sub: 'p1', roles: ['Submitter'] }),
      );
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(McpToolError);
    expect((caught as McpToolError).code).toBe(MCP_ERROR.resource_not_found);
  });

  it('throws resource_not_found (-32003) when the requested version is unknown', () => {
    db = new Database(':memory:');
    runMigrations(db);

    seedPublished(db, {
      id: 's-1',
      manifest: makeManifest({ version: '1.0.0' }),
      submittedAt: '2026-05-24T10:00:00.000Z',
      publishedAt: '2026-05-24T10:05:00.000Z',
    });

    let caught: unknown;
    try {
      registryDownloadUrlHandler(
        db,
        { owner: 'acme', name: 'x', version: '9.9.9' },
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
      registryDownloadUrlHandler(
        db,
        { owner: 'acme', name: 'x', version: '1.0.0' },
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
      registryDownloadUrlHandler(db, { owner: 'acme', name: 'x' }, {});
    } catch (err) {
      caught = err;
    }

    expect((caught as McpToolError).code).toBe(
      MCP_ERROR.authentication_required,
    );
  });
});

describe('registerRegistryDownloadUrl', () => {
  let db: Database.Database | undefined;

  afterEach(() => {
    db?.close();
    db = undefined;
  });

  it('registers registry_download_url on the server', () => {
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

    registerRegistryDownloadUrl(server, db, deps);

    const internal = server as unknown as {
      _registeredTools?: Record<string, { enabled?: boolean }>;
    };
    expect(internal._registeredTools?.registry_download_url).toBeDefined();
    expect(internal._registeredTools?.registry_download_url?.enabled).not.toBe(
      false,
    );
  });
});
