import type { SkillManifest, Submission } from '@asr/core';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import type { AuthVariables, Identity } from '../../auth/types.js';
import {
  registerApproveRoute,
  type ApproveReviewInput,
  type ApproveReviewResult,
  type ApproveSubmissionLoader,
} from './approve.js';

describe('POST /api/v1/submissions/:id/approve', () => {
  it('publishes the submission when a Compliance caller differs from the submitter', async () => {
    const auditCalls: Array<{ action: string; detail: Record<string, unknown> }> = [];
    const reviewCalls: ApproveReviewInput[] = [];
    const app = makeApp({
      identity: { sub: 'reviewer-1', roles: ['Compliance'] },
      loadSubmission: (id) =>
        id === 'sub-approve-ok' ? buildSubmission({ id, submittedBy: 'submitter-1' }) : undefined,
      deliverReviewApproval: (input) => {
        reviewCalls.push(input);
        return {
          publishedAt: '2026-05-26T10:00:00.000Z',
          mergeCommit: 'commit-abc',
        } satisfies ApproveReviewResult;
      },
      audit: (action, detail) => {
        auditCalls.push({ action, detail });
      },
    });

    const res = await app.request('/api/v1/submissions/sub-approve-ok/approve', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ comment: 'looks good' }),
    });

    expect(res.status).toBe(200);
    const payload = (await res.json()) as {
      status: { phase: string; publishedAt: string; mergeCommit: string };
      publishedVersion: string;
      registryUrl: string;
    };
    expect(payload.status.phase).toBe('published');
    expect(payload.status.publishedAt).toBe('2026-05-26T10:00:00.000Z');
    expect(payload.status.mergeCommit).toBe('commit-abc');
    expect(payload.publishedVersion).toBe('1.0.0');
    expect(payload.registryUrl).toBe('/skills/submitter-1/demo-skill');

    expect(reviewCalls).toEqual([
      { submissionId: 'sub-approve-ok', actor: 'reviewer-1', comment: 'looks good' },
    ]);
    expect(auditCalls).toEqual([
      {
        action: 'workflow.review.approved',
        detail: {
          submissionId: 'sub-approve-ok',
          skillName: 'demo-skill',
          version: '1.0.0',
          actor: 'reviewer-1',
          mergeCommit: 'commit-abc',
          comment: 'looks good',
        },
      },
    ]);
  });

  it('rejects with separation_of_duties_violation when caller sub equals the submitter', async () => {
    const reviewCalls: ApproveReviewInput[] = [];
    const auditCalls: unknown[] = [];
    const app = makeApp({
      identity: { sub: 'submitter-1', roles: ['Compliance'] },
      loadSubmission: (id) =>
        id === 'sub-sod' ? buildSubmission({ id, submittedBy: 'submitter-1' }) : undefined,
      deliverReviewApproval: (input) => {
        reviewCalls.push(input);
        return { publishedAt: '2026-05-26T10:00:00.000Z', mergeCommit: 'never' };
      },
      audit: (action, detail) => {
        auditCalls.push({ action, detail });
      },
    });

    const res = await app.request('/api/v1/submissions/sub-sod/approve', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(403);
    const payload = (await res.json()) as { error: string };
    expect(payload.error).toBe('separation_of_duties_violation');
    expect(reviewCalls).toEqual([]);
    expect(auditCalls).toEqual([]);
  });

  it('returns 403 for an empty-sub SoD attempt against an empty-sub submission', async () => {
    const reviewCalls: ApproveReviewInput[] = [];
    const app = makeApp({
      identity: { sub: '', roles: ['Compliance'] },
      loadSubmission: (id) =>
        id === 'sub-empty-sod' ? buildSubmission({ id, submittedBy: '' }) : undefined,
      deliverReviewApproval: (input) => {
        reviewCalls.push(input);
        return { publishedAt: '2026-05-26T10:00:00.000Z', mergeCommit: 'never' };
      },
    });

    const res = await app.request('/api/v1/submissions/sub-empty-sod/approve', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual({
      error: 'separation_of_duties_violation',
    });
    expect(reviewCalls).toEqual([]);
  });

  it('returns submission_not_found when the submission id is unknown', async () => {
    const app = makeApp({
      identity: { sub: 'reviewer-1', roles: ['Compliance'] },
      loadSubmission: () => undefined,
      deliverReviewApproval: () => ({
        publishedAt: '2026-05-26T10:00:00.000Z',
        mergeCommit: 'commit',
      }),
    });

    const res = await app.request('/api/v1/submissions/sub-missing/approve', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({ error: 'submission_not_found' });
  });

  interface MakeAppInput {
    identity: Identity;
    loadSubmission: ApproveSubmissionLoader;
    deliverReviewApproval: (input: ApproveReviewInput) => ApproveReviewResult | Promise<ApproveReviewResult>;
    audit?: (action: string, detail: Record<string, unknown>) => void | Promise<void>;
  }

  function makeApp(input: MakeAppInput): Hono<{ Variables: AuthVariables }> {
    const app = new Hono<{ Variables: AuthVariables }>();
    app.use('*', async (c, next) => {
      c.set('identity', input.identity);
      await next();
    });

    registerApproveRoute(app, {
      loadSubmission: input.loadSubmission,
      deliverReviewApproval: input.deliverReviewApproval,
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
