import type { SkillManifest, Submission } from '@asr/core';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import type { AuthVariables, Identity } from '../../auth/types.js';
import {
  registerRejectRoute,
  type RejectReviewInput,
  type RejectReviewResult,
  type RejectSubmissionLoader,
} from './reject.js';

describe('POST /api/v1/submissions/:id/reject', () => {
  it('rejects the submission when a Compliance caller differs from the submitter', async () => {
    const auditCalls: Array<{ action: string; detail: Record<string, unknown> }> = [];
    const rejectCalls: RejectReviewInput[] = [];
    const app = makeApp({
      identity: { sub: 'reviewer-1', roles: ['Compliance'] },
      loadSubmission: (id) =>
        id === 'sub-reject-ok' ? buildSubmission({ id, submittedBy: 'submitter-1' }) : undefined,
      deliverReviewRejection: (input) => {
        rejectCalls.push(input);
        return {
          rejectedAt: '2026-05-26T10:00:00.000Z',
        } satisfies RejectReviewResult;
      },
      audit: (action, detail) => {
        auditCalls.push({ action, detail });
      },
    });

    const reason = 'permissions exceed the declared filesystem scope';
    const res = await app.request('/api/v1/submissions/sub-reject-ok/reject', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reason }),
    });

    expect(res.status).toBe(200);
    const payload = (await res.json()) as {
      status: { phase: string; rejectedAt: string; reason: string };
    };
    expect(payload.status.phase).toBe('rejected');
    expect(payload.status.rejectedAt).toBe('2026-05-26T10:00:00.000Z');
    expect(payload.status.reason).toBe(reason);

    expect(rejectCalls).toEqual([
      { submissionId: 'sub-reject-ok', actor: 'reviewer-1', reason },
    ]);
    expect(auditCalls).toEqual([
      {
        action: 'workflow.review.rejected',
        detail: {
          submissionId: 'sub-reject-ok',
          skillName: 'demo-skill',
          version: '1.0.0',
          actor: 'reviewer-1',
          reason,
        },
      },
    ]);
  });

  it('returns 400 invalid_manifest when reason is shorter than 10 chars', async () => {
    const rejectCalls: RejectReviewInput[] = [];
    const auditCalls: unknown[] = [];
    const app = makeApp({
      identity: { sub: 'reviewer-1', roles: ['Compliance'] },
      loadSubmission: (id) =>
        id === 'sub-short' ? buildSubmission({ id, submittedBy: 'submitter-1' }) : undefined,
      deliverReviewRejection: (input) => {
        rejectCalls.push(input);
        return { rejectedAt: '2026-05-26T10:00:00.000Z' };
      },
      audit: (action, detail) => {
        auditCalls.push({ action, detail });
      },
    });

    const res = await app.request('/api/v1/submissions/sub-short/reject', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'too-shrt' }),
    });

    expect(res.status).toBe(400);
    const payload = (await res.json()) as {
      error: string;
      message?: string;
      details?: Record<string, string>;
    };
    expect(payload.error).toBe('invalid_manifest');
    expect(payload.message).toBe('reason must be 10-500 characters');
    expect(payload.details?.reason).toBeDefined();
    expect(rejectCalls).toEqual([]);
    expect(auditCalls).toEqual([]);
  });

  it('returns 400 invalid_manifest when reason is longer than 500 chars', async () => {
    const app = makeApp({
      identity: { sub: 'reviewer-1', roles: ['Compliance'] },
      loadSubmission: (id) =>
        id === 'sub-long' ? buildSubmission({ id, submittedBy: 'submitter-1' }) : undefined,
      deliverReviewRejection: () => ({ rejectedAt: '2026-05-26T10:00:00.000Z' }),
    });

    const res = await app.request('/api/v1/submissions/sub-long/reject', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'x'.repeat(501) }),
    });

    expect(res.status).toBe(400);
    const payload = (await res.json()) as { error: string };
    expect(payload.error).toBe('invalid_manifest');
  });

  it('returns 400 invalid_manifest when reason is missing', async () => {
    const app = makeApp({
      identity: { sub: 'reviewer-1', roles: ['Compliance'] },
      loadSubmission: (id) =>
        id === 'sub-missing-reason' ? buildSubmission({ id, submittedBy: 'submitter-1' }) : undefined,
      deliverReviewRejection: () => ({ rejectedAt: '2026-05-26T10:00:00.000Z' }),
    });

    const res = await app.request('/api/v1/submissions/sub-missing-reason/reject', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(400);
    const payload = (await res.json()) as { error: string };
    expect(payload.error).toBe('invalid_manifest');
  });

  it('rejects with separation_of_duties_violation when caller sub equals the submitter', async () => {
    const rejectCalls: RejectReviewInput[] = [];
    const auditCalls: unknown[] = [];
    const app = makeApp({
      identity: { sub: 'submitter-1', roles: ['Compliance'] },
      loadSubmission: (id) =>
        id === 'sub-sod' ? buildSubmission({ id, submittedBy: 'submitter-1' }) : undefined,
      deliverReviewRejection: (input) => {
        rejectCalls.push(input);
        return { rejectedAt: '2026-05-26T10:00:00.000Z' };
      },
      audit: (action, detail) => {
        auditCalls.push({ action, detail });
      },
    });

    const res = await app.request('/api/v1/submissions/sub-sod/reject', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'a perfectly long enough reason value' }),
    });

    expect(res.status).toBe(403);
    const payload = (await res.json()) as { error: string };
    expect(payload.error).toBe('separation_of_duties_violation');
    expect(rejectCalls).toEqual([]);
    expect(auditCalls).toEqual([]);
  });

  it('returns submission_not_found when the submission id is unknown', async () => {
    const app = makeApp({
      identity: { sub: 'reviewer-1', roles: ['Compliance'] },
      loadSubmission: () => undefined,
      deliverReviewRejection: () => ({ rejectedAt: '2026-05-26T10:00:00.000Z' }),
    });

    const res = await app.request('/api/v1/submissions/sub-missing/reject', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'a perfectly long enough reason value' }),
    });

    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({ error: 'submission_not_found' });
  });

  interface MakeAppInput {
    identity: Identity;
    loadSubmission: RejectSubmissionLoader;
    deliverReviewRejection: (input: RejectReviewInput) => RejectReviewResult | Promise<RejectReviewResult>;
    audit?: (action: string, detail: Record<string, unknown>) => void | Promise<void>;
  }

  function makeApp(input: MakeAppInput): Hono<{ Variables: AuthVariables }> {
    const app = new Hono<{ Variables: AuthVariables }>();
    app.use('*', async (c, next) => {
      c.set('identity', input.identity);
      await next();
    });

    registerRejectRoute(app, {
      loadSubmission: input.loadSubmission,
      deliverReviewRejection: input.deliverReviewRejection,
      audit: input.audit,
    });

    return app;
  }
});

interface SubmissionFixture {
  id: string;
  submittedBy: string;
}

function buildSubmission(input: SubmissionFixture): Submission {
  const manifest: SkillManifest = {
    name: 'demo-skill',
    version: '1.0.0',
    author: 'submitter-1',
    description: 'Demo skill under review',
    tags: ['demo'],
    kind: 'skill',
    permissions: {
      network: false,
      filesystem: 'none',
      subprocess: false,
      environment: [],
    },
  };

  return {
    id: input.id,
    manifest,
    classification: 'md-only',
    contentHash: 'sha256:demo',
    submittedAt: '2026-05-26T09:00:00.000Z',
    submittedBy: input.submittedBy,
    status: { phase: 'compliance-review' },
  };
}
