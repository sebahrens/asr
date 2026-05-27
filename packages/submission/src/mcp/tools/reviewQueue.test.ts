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
  registerReviewQueue,
  reviewQueueHandler,
  type ReviewQueueEntry,
} from './reviewQueue.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

function makeManifest(name: string, version = '1.0.0'): SkillManifest {
  return {
    name,
    version,
    author: 'submitter@example.com',
    description: `${name} skill awaiting review`,
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

function seedReviewSubmission(
  db: Database.Database,
  id: string,
  manifest: SkillManifest,
  submittedAt: string,
  submittedBy = 'submitter@example.com',
): Submission {
  const submission: Submission = {
    id,
    manifest,
    classification: 'md-only',
    contentHash: `sha256:${id}`,
    submittedAt,
    submittedBy,
    status: { phase: 'compliance-review' },
  };
  insertSubmission(db, {
    id: submission.id,
    manifestJson: JSON.stringify(submission.manifest),
    classification: submission.classification,
    contentHash: submission.contentHash,
    submittedAt: submission.submittedAt,
    submittedBy: submission.submittedBy,
    statusPhase: submission.status.phase,
    statusJson: JSON.stringify(submission.status),
  });
  return submission;
}

function extraFor(principal: Identity): unknown {
  return {
    authInfo: { extra: { principal } },
    sessionId: 'test-session',
  };
}

describe('reviewQueueHandler', () => {
  let db: Database.Database | undefined;

  afterEach(() => {
    db?.close();
    db = undefined;
  });

  it('returns submissions in the compliance-review phase for a Compliance principal', async () => {
    db = new Database(':memory:');
    runMigrations(db);

    seedReviewSubmission(
      db,
      'sub-pending-1',
      makeManifest('alpha'),
      '2026-05-24T10:00:00.000Z',
    );

    const result = reviewQueueHandler(
      db,
      { limit: 20 },
      extraFor({ sub: 'reviewer-1', roles: ['Compliance'] }),
    );

    expect(result.structuredContent.submissions).toHaveLength(1);
    const entry: ReviewQueueEntry = result.structuredContent.submissions[0]!;
    expect(entry).toMatchObject({
      id: 'sub-pending-1',
      skillName: 'alpha',
      status: { phase: 'compliance-review' },
    });
    expect(result.content[0]?.type).toBe('text');
    const parsed = JSON.parse(result.content[0]!.text) as {
      submissions: ReviewQueueEntry[];
    };
    expect(parsed.submissions[0]?.id).toBe('sub-pending-1');
  });

  it('skips submissions not in the compliance-review phase', () => {
    db = new Database(':memory:');
    runMigrations(db);

    seedReviewSubmission(
      db,
      'sub-pending',
      makeManifest('alpha'),
      '2026-05-24T10:00:00.000Z',
    );
    insertSubmission(db, {
      id: 'sub-scanning',
      manifestJson: JSON.stringify(makeManifest('beta')),
      classification: 'md-only',
      contentHash: 'sha256:scanning',
      submittedAt: '2026-05-24T11:00:00.000Z',
      submittedBy: 'submitter@example.com',
      statusPhase: 'scanning',
      statusJson: '{"phase":"scanning","scanJobId":"s1"}',
    });

    const result = reviewQueueHandler(
      db,
      { limit: 20 },
      extraFor({ sub: 'reviewer-1', roles: ['Compliance'] }),
    );

    expect(
      result.structuredContent.submissions.map((s) => s.id),
    ).toEqual(['sub-pending']);
  });

  it('orders the queue oldest-first', () => {
    db = new Database(':memory:');
    runMigrations(db);

    seedReviewSubmission(
      db,
      'sub-newer',
      makeManifest('newer'),
      '2026-05-24T12:00:00.000Z',
    );
    seedReviewSubmission(
      db,
      'sub-older',
      makeManifest('older'),
      '2026-05-24T08:00:00.000Z',
    );

    const result = reviewQueueHandler(
      db,
      { limit: 20 },
      extraFor({ sub: 'reviewer-1', roles: ['Compliance'] }),
    );

    expect(
      result.structuredContent.submissions.map((s) => s.id),
    ).toEqual(['sub-older', 'sub-newer']);
  });

  it('respects the limit', () => {
    db = new Database(':memory:');
    runMigrations(db);

    for (let i = 0; i < 3; i += 1) {
      seedReviewSubmission(
        db,
        `sub-${i}`,
        makeManifest(`s${i}`),
        `2026-05-24T1${i}:00:00.000Z`,
      );
    }

    const result = reviewQueueHandler(
      db,
      { limit: 2 },
      extraFor({ sub: 'reviewer-1', roles: ['Compliance'] }),
    );

    expect(result.structuredContent.submissions.map((s) => s.id)).toEqual([
      'sub-0',
      'sub-1',
    ]);
  });

  it('throws insufficient_permissions (-32001) for a Submitter-only principal', () => {
    db = new Database(':memory:');
    runMigrations(db);

    seedReviewSubmission(
      db,
      'sub-pending',
      makeManifest('alpha'),
      '2026-05-24T10:00:00.000Z',
    );

    let caught: unknown;
    try {
      reviewQueueHandler(
        db,
        { limit: 20 },
        extraFor({ sub: 'submitter-1', roles: ['Submitter'] }),
      );
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(McpToolError);
    const err = caught as McpToolError;
    expect(err.code).toBe(MCP_ERROR.insufficient_permissions);
    expect(err.code).toBe(-32001);
    expect(err.data).toMatchObject({ required: 'Compliance' });
  });

  it('throws authentication_required (-32002) when no principal is bound to extra', () => {
    db = new Database(':memory:');
    runMigrations(db);

    let caught: unknown;
    try {
      reviewQueueHandler(db, { limit: 20 }, {});
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(McpToolError);
    expect((caught as McpToolError).code).toBe(MCP_ERROR.authentication_required);
  });
});

describe('registerReviewQueue', () => {
  let db: Database.Database | undefined;

  afterEach(() => {
    db?.close();
    db = undefined;
  });

  it('registers review_queue on tools/list', async () => {
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

    registerReviewQueue(server, db, deps);

    // After registration the tool must be listed (not disabled).
    const internal = server as unknown as {
      _registeredTools?: Record<string, { enabled?: boolean }>;
    };
    expect(internal._registeredTools?.review_queue).toBeDefined();
    expect(internal._registeredTools?.review_queue?.enabled).not.toBe(false);
  });
});
