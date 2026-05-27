import type { SkillManifest, Submission } from '@asr/core';
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
  registerSubmissionStatus,
  submissionStatusHandler,
} from './submissionStatus.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

function makeManifest(name: string, version = '1.0.0'): SkillManifest {
  return {
    name,
    version,
    author: 'submitter@example.com',
    description: `${name} skill`,
    tags: ['demo'],
    kind: 'skill',
    permissions: {
      network: false,
      filesystem: 'none',
      subprocess: false,
      environment: [],
    },
  };
}

function seedSubmission(
  db: Database.Database,
  id: string,
  manifest: SkillManifest,
  submittedAt: string,
  submittedBy: string,
  phase: Submission['status']['phase'] = 'uploaded',
): void {
  const status: Submission['status'] =
    phase === 'uploaded' ? { phase: 'uploaded' } : { phase: 'compliance-review' };
  insertSubmission(db, {
    id,
    manifestJson: JSON.stringify(manifest),
    classification: 'md-only',
    contentHash: `sha256:${id}`,
    submittedAt,
    submittedBy,
    statusPhase: status.phase,
    statusJson: JSON.stringify(status),
  });
}

function extraFor(principal: Identity): unknown {
  return {
    authInfo: { extra: { principal } },
    sessionId: 'test-session',
  };
}

describe('submissionStatusHandler', () => {
  let db: Database.Database | undefined;

  afterEach(() => {
    db?.close();
    db = undefined;
  });

  it('returns the submission for its owning principal', () => {
    db = new Database(':memory:');
    runMigrations(db);

    seedSubmission(
      db,
      'sub-1',
      makeManifest('sub-1'),
      '2026-05-24T08:00:00.000Z',
      'principalA',
      'compliance-review',
    );

    const result = submissionStatusHandler(
      db,
      { submissionId: 'sub-1' },
      extraFor({ sub: 'principalA', roles: ['Submitter'] }),
    );

    expect(result.structuredContent.submission.id).toBe('sub-1');
    expect(result.structuredContent.submission.status.phase).toBe('compliance-review');
    expect(result.structuredContent.submission.manifest.name).toBe('sub-1');
    expect(result.structuredContent.submission.classification).toBe('md-only');
    expect(result.structuredContent.submission.submittedBy).toBe('principalA');

    expect(result.content[0]?.type).toBe('text');
    const parsed = JSON.parse(result.content[0]!.text) as { submission: Submission };
    expect(parsed.submission.id).toBe('sub-1');
  });

  it('returns resource_not_found (-32003) when the submission is owned by another principal', () => {
    db = new Database(':memory:');
    runMigrations(db);

    seedSubmission(
      db,
      'sub-1',
      makeManifest('sub-1'),
      '2026-05-24T08:00:00.000Z',
      'principalA',
    );

    let caught: unknown;
    try {
      submissionStatusHandler(
        db,
        { submissionId: 'sub-1' },
        extraFor({ sub: 'principalB', roles: ['Submitter'] }),
      );
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(McpToolError);
    const err = caught as McpToolError;
    expect(err.code).toBe(MCP_ERROR.resource_not_found);
    expect(err.code).toBe(-32003);
    // Must NOT leak existence as insufficient_permissions.
    expect(err.code).not.toBe(MCP_ERROR.insufficient_permissions);
  });

  it('returns resource_not_found (-32003) for an unknown submission id', () => {
    db = new Database(':memory:');
    runMigrations(db);

    let caught: unknown;
    try {
      submissionStatusHandler(
        db,
        { submissionId: 'does-not-exist' },
        extraFor({ sub: 'principalA', roles: ['Submitter'] }),
      );
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(McpToolError);
    expect((caught as McpToolError).code).toBe(MCP_ERROR.resource_not_found);
  });

  it('throws insufficient_permissions (-32001) for a principal lacking the Submitter role', () => {
    db = new Database(':memory:');
    runMigrations(db);

    seedSubmission(
      db,
      'sub-1',
      makeManifest('sub-1'),
      '2026-05-24T08:00:00.000Z',
      'principalA',
    );

    let caught: unknown;
    try {
      submissionStatusHandler(
        db,
        { submissionId: 'sub-1' },
        extraFor({ sub: 'principalA', roles: ['Compliance'] }),
      );
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(McpToolError);
    const err = caught as McpToolError;
    expect(err.code).toBe(MCP_ERROR.insufficient_permissions);
    expect(err.data).toMatchObject({ required: 'Submitter' });
  });

  it('throws authentication_required (-32002) when no principal is bound to extra', () => {
    db = new Database(':memory:');
    runMigrations(db);

    let caught: unknown;
    try {
      submissionStatusHandler(db, { submissionId: 'sub-1' }, {});
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(McpToolError);
    expect((caught as McpToolError).code).toBe(MCP_ERROR.authentication_required);
  });
});

describe('registerSubmissionStatus', () => {
  let db: Database.Database | undefined;

  afterEach(() => {
    db?.close();
    db = undefined;
  });

  it('registers submission_status on tools/list', () => {
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

    registerSubmissionStatus(server, db, deps);

    const internal = server as unknown as {
      _registeredTools?: Record<string, { enabled?: boolean }>;
    };
    expect(internal._registeredTools?.submission_status).toBeDefined();
    expect(internal._registeredTools?.submission_status?.enabled).not.toBe(false);
  });
});
