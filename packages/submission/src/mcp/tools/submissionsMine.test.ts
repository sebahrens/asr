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
  registerSubmissionsMine,
  submissionsMineHandler,
} from './submissionsMine.js';
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

describe('submissionsMineHandler', () => {
  let db: Database.Database | undefined;

  afterEach(() => {
    db?.close();
    db = undefined;
  });

  it('returns only the caller principal\'s own submissions, newest-first', () => {
    db = new Database(':memory:');
    runMigrations(db);

    // Two submissions for principalA, one for principalB.
    seedSubmission(
      db,
      'a-old',
      makeManifest('a-old'),
      '2026-05-24T08:00:00.000Z',
      'principalA',
    );
    seedSubmission(
      db,
      'a-new',
      makeManifest('a-new'),
      '2026-05-24T12:00:00.000Z',
      'principalA',
      'compliance-review',
    );
    seedSubmission(
      db,
      'b-one',
      makeManifest('b-one'),
      '2026-05-24T10:00:00.000Z',
      'principalB',
    );

    const result = submissionsMineHandler(
      db,
      { limit: 50 },
      extraFor({ sub: 'principalA', roles: ['Submitter'] }),
    );

    const ids = result.structuredContent.submissions.map((s) => s.id);
    expect(ids).toEqual(['a-new', 'a-old']);
    expect(ids).not.toContain('b-one');

    const aNew = result.structuredContent.submissions[0]!;
    expect(aNew.status.phase).toBe('compliance-review');
    expect(aNew.manifest.name).toBe('a-new');
    expect(aNew.classification).toBe('md-only');
    expect(aNew.submittedAt).toBe('2026-05-24T12:00:00.000Z');

    expect(result.content[0]?.type).toBe('text');
    const parsed = JSON.parse(result.content[0]!.text) as {
      submissions: Submission[];
    };
    expect(parsed.submissions.map((s) => s.id)).toEqual(['a-new', 'a-old']);
  });

  it('respects the limit', () => {
    db = new Database(':memory:');
    runMigrations(db);

    for (let i = 0; i < 3; i += 1) {
      seedSubmission(
        db,
        `mine-${i}`,
        makeManifest(`mine-${i}`),
        `2026-05-24T1${i}:00:00.000Z`,
        'principalA',
      );
    }

    const result = submissionsMineHandler(
      db,
      { limit: 2 },
      extraFor({ sub: 'principalA', roles: ['Submitter'] }),
    );

    expect(result.structuredContent.submissions).toHaveLength(2);
    // Newest first: mine-2, mine-1.
    expect(result.structuredContent.submissions.map((s) => s.id)).toEqual([
      'mine-2',
      'mine-1',
    ]);
  });

  it('throws insufficient_permissions (-32001) for a principal lacking the Submitter role', () => {
    db = new Database(':memory:');
    runMigrations(db);

    seedSubmission(
      db,
      'a-1',
      makeManifest('a-1'),
      '2026-05-24T08:00:00.000Z',
      'principalA',
    );

    let caught: unknown;
    try {
      submissionsMineHandler(
        db,
        { limit: 50 },
        extraFor({ sub: 'principalA', roles: ['Compliance'] }),
      );
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(McpToolError);
    const err = caught as McpToolError;
    expect(err.code).toBe(MCP_ERROR.insufficient_permissions);
    expect(err.code).toBe(-32001);
    expect(err.data).toMatchObject({ required: 'Submitter' });
  });

  it('throws authentication_required (-32002) when no principal is bound to extra', () => {
    db = new Database(':memory:');
    runMigrations(db);

    let caught: unknown;
    try {
      submissionsMineHandler(db, { limit: 50 }, {});
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(McpToolError);
    expect((caught as McpToolError).code).toBe(MCP_ERROR.authentication_required);
  });
});

describe('registerSubmissionsMine', () => {
  let db: Database.Database | undefined;

  afterEach(() => {
    db?.close();
    db = undefined;
  });

  it('registers submissions_mine on tools/list', () => {
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

    registerSubmissionsMine(server, db, deps);

    const internal = server as unknown as {
      _registeredTools?: Record<string, { enabled?: boolean }>;
    };
    expect(internal._registeredTools?.submissions_mine).toBeDefined();
    expect(internal._registeredTools?.submissions_mine?.enabled).not.toBe(false);
  });
});
