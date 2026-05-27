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
  registerReviewDecision,
  reviewDecisionHandler,
  type ReviewDecisionDeps,
  type ReviewDecisionApproveInput,
  type ReviewDecisionRejectInput,
} from './reviewDecision.js';
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
  submittedBy: string,
): Submission {
  const submission: Submission = {
    id,
    manifest,
    classification: 'md-only',
    contentHash: `sha256:${id}`,
    submittedAt: '2026-05-24T10:00:00.000Z',
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

function makeDeps(
  overrides: Partial<ReviewDecisionDeps> = {},
): {
  deps: ReviewDecisionDeps;
  approveCalls: ReviewDecisionApproveInput[];
  rejectCalls: ReviewDecisionRejectInput[];
} {
  const approveCalls: ReviewDecisionApproveInput[] = [];
  const rejectCalls: ReviewDecisionRejectInput[] = [];
  const deps: ReviewDecisionDeps = {
    deliverReviewApproval: (input) => {
      approveCalls.push(input);
      return {
        publishedAt: '2026-05-26T10:00:00.000Z',
        mergeCommit: 'commit-abc',
      };
    },
    deliverReviewRejection: (input) => {
      rejectCalls.push(input);
      return { rejectedAt: '2026-05-26T11:00:00.000Z' };
    },
    ...overrides,
  };
  return { deps, approveCalls, rejectCalls };
}

describe('reviewDecisionHandler', () => {
  let db: Database.Database | undefined;

  afterEach(() => {
    db?.close();
    db = undefined;
  });

  it('throws insufficient_permissions (-32001) for a Submitter-only principal', async () => {
    db = new Database(':memory:');
    runMigrations(db);
    seedReviewSubmission(db, 'sub-1', makeManifest('alpha'), 'submitter-1');

    const { deps, approveCalls } = makeDeps();
    let caught: unknown;
    try {
      await reviewDecisionHandler(
        db,
        deps,
        { submissionId: 'sub-1', decision: 'approve' },
        extraFor({ sub: 'caller-1', roles: ['Submitter'] }),
      );
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(McpToolError);
    const err = caught as McpToolError;
    expect(err.code).toBe(MCP_ERROR.insufficient_permissions);
    expect(err.code).toBe(-32001);
    expect(approveCalls).toEqual([]);
  });

  it('returns isError result with separation_of_duties_violation when Compliance caller sub === submitter sub', async () => {
    db = new Database(':memory:');
    runMigrations(db);
    seedReviewSubmission(db, 'sub-2', makeManifest('beta'), 'reviewer-1');

    const { deps, approveCalls } = makeDeps();
    const result = await reviewDecisionHandler(
      db,
      deps,
      { submissionId: 'sub-2', decision: 'approve' },
      extraFor({ sub: 'reviewer-1', roles: ['Compliance'] }),
    );

    expect(result.isError).toBe(true);
    expect(result.content[0]?.type).toBe('text');
    expect(result.content[0]?.text).toContain('separation_of_duties_violation');
    expect(approveCalls).toEqual([]);
  });

  it('transitions to phase published when a Compliance caller with a differing sub approves', async () => {
    db = new Database(':memory:');
    runMigrations(db);
    seedReviewSubmission(db, 'sub-3', makeManifest('gamma'), 'submitter-1');

    const { deps, approveCalls } = makeDeps();
    const result = await reviewDecisionHandler(
      db,
      deps,
      { submissionId: 'sub-3', decision: 'approve', reason: 'looks good' },
      extraFor({ sub: 'reviewer-2', roles: ['Compliance'] }),
    );

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent?.status).toEqual({
      phase: 'published',
      publishedAt: '2026-05-26T10:00:00.000Z',
      mergeCommit: 'commit-abc',
    });
    expect(approveCalls).toEqual([
      { submissionId: 'sub-3', actor: 'reviewer-2', comment: 'looks good' },
    ]);
  });

  it('transitions to phase rejected when a Compliance caller rejects with a valid reason', async () => {
    db = new Database(':memory:');
    runMigrations(db);
    seedReviewSubmission(db, 'sub-4', makeManifest('delta'), 'submitter-1');

    const { deps, rejectCalls } = makeDeps();
    const result = await reviewDecisionHandler(
      db,
      deps,
      {
        submissionId: 'sub-4',
        decision: 'reject',
        reason: 'manifest fails the basic checklist',
      },
      extraFor({ sub: 'reviewer-2', roles: ['Compliance'] }),
    );

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent?.status).toEqual({
      phase: 'rejected',
      rejectedAt: '2026-05-26T11:00:00.000Z',
      reason: 'manifest fails the basic checklist',
    });
    expect(rejectCalls).toEqual([
      {
        submissionId: 'sub-4',
        actor: 'reviewer-2',
        reason: 'manifest fails the basic checklist',
      },
    ]);
  });

  it('returns isError when rejecting with a missing or too-short reason', async () => {
    db = new Database(':memory:');
    runMigrations(db);
    seedReviewSubmission(db, 'sub-5', makeManifest('eps'), 'submitter-1');

    const { deps, rejectCalls } = makeDeps();
    const result = await reviewDecisionHandler(
      db,
      deps,
      { submissionId: 'sub-5', decision: 'reject', reason: 'too short' },
      extraFor({ sub: 'reviewer-2', roles: ['Compliance'] }),
    );

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('invalid_reason');
    expect(rejectCalls).toEqual([]);
  });

  it('throws resource_not_found (-32003) when the submission id is unknown', async () => {
    db = new Database(':memory:');
    runMigrations(db);

    const { deps } = makeDeps();
    let caught: unknown;
    try {
      await reviewDecisionHandler(
        db,
        deps,
        { submissionId: 'missing', decision: 'approve' },
        extraFor({ sub: 'reviewer-2', roles: ['Compliance'] }),
      );
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(McpToolError);
    expect((caught as McpToolError).code).toBe(MCP_ERROR.resource_not_found);
  });

  it('throws authentication_required (-32002) when no principal is bound to extra', async () => {
    db = new Database(':memory:');
    runMigrations(db);

    const { deps } = makeDeps();
    let caught: unknown;
    try {
      await reviewDecisionHandler(
        db,
        deps,
        { submissionId: 'whatever', decision: 'approve' },
        {},
      );
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(McpToolError);
    expect((caught as McpToolError).code).toBe(MCP_ERROR.authentication_required);
  });
});

describe('registerReviewDecision', () => {
  let db: Database.Database | undefined;

  afterEach(() => {
    db?.close();
    db = undefined;
  });

  it('registers review_decision on tools/list', () => {
    db = new Database(':memory:');
    runMigrations(db);

    const server = new McpServer({ name: 'asr-test', version: '0.0.0' });
    const wrapDeps: WrapToolHandlerDeps = {
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
    const { deps } = makeDeps();

    registerReviewDecision(server, db, deps, wrapDeps);

    const internal = server as unknown as {
      _registeredTools?: Record<string, { enabled?: boolean }>;
    };
    expect(internal._registeredTools?.review_decision).toBeDefined();
    expect(internal._registeredTools?.review_decision?.enabled).not.toBe(false);
  });
});
