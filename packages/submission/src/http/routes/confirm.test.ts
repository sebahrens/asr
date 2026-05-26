import type { SkillManifest, Submission, SubmissionStatus } from '@asr/core';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import type { AuthVariables, Identity } from '../../auth/types.js';
import {
  registerConfirmRoute,
  type ConfirmSignalInput,
  type ConfirmSubmissionLoader,
} from './confirm.js';

describe('POST /api/v1/submissions/:id/confirm', () => {
  it('delivers the confirmation HITL signal and transitions the submission to compliance-review', async () => {
    const signalCalls: ConfirmSignalInput[] = [];
    const app = makeApp({
      identity: { sub: 'submitter-1', roles: ['Submitter'] },
      loadSubmission: (id) =>
        id === 'sub-confirm-ok'
          ? buildSubmission({
              id,
              submittedBy: 'submitter-1',
              status: { phase: 'user-confirmation-pending' },
            })
          : undefined,
      deliverConfirmation: (input) => {
        signalCalls.push(input);
      },
    });

    const res = await app.request('/api/v1/submissions/sub-confirm-ok/confirm', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(200);
    const payload = (await res.json()) as { status: { phase: string } };
    expect(payload.status.phase).toBe('compliance-review');
    expect(signalCalls).toEqual([{ submissionId: 'sub-confirm-ok' }]);
  });

  it('accepts an empty body', async () => {
    const signalCalls: ConfirmSignalInput[] = [];
    const app = makeApp({
      identity: { sub: 'submitter-1', roles: ['Submitter'] },
      loadSubmission: (id) =>
        id === 'sub-confirm-empty'
          ? buildSubmission({
              id,
              submittedBy: 'submitter-1',
              status: { phase: 'user-confirmation-pending' },
            })
          : undefined,
      deliverConfirmation: (input) => {
        signalCalls.push(input);
      },
    });

    const res = await app.request('/api/v1/submissions/sub-confirm-empty/confirm', {
      method: 'POST',
    });

    expect(res.status).toBe(200);
    const payload = (await res.json()) as { status: { phase: string } };
    expect(payload.status.phase).toBe('compliance-review');
    expect(signalCalls).toEqual([{ submissionId: 'sub-confirm-empty' }]);
  });

  it('returns 404 submission_not_found when the submission id is unknown', async () => {
    const signalCalls: ConfirmSignalInput[] = [];
    const app = makeApp({
      identity: { sub: 'submitter-1', roles: ['Submitter'] },
      loadSubmission: () => undefined,
      deliverConfirmation: (input) => {
        signalCalls.push(input);
      },
    });

    const res = await app.request('/api/v1/submissions/sub-missing/confirm', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({ error: 'submission_not_found' });
    expect(signalCalls).toEqual([]);
  });

  interface MakeAppInput {
    identity: Identity;
    loadSubmission: ConfirmSubmissionLoader;
    deliverConfirmation: (input: ConfirmSignalInput) => void | Promise<void>;
  }

  function makeApp(input: MakeAppInput): Hono<{ Variables: AuthVariables }> {
    const app = new Hono<{ Variables: AuthVariables }>();
    app.use('*', async (c, next) => {
      c.set('identity', input.identity);
      await next();
    });

    registerConfirmRoute(app, {
      loadSubmission: input.loadSubmission,
      deliverConfirmation: input.deliverConfirmation,
    });

    return app;
  }
});

interface SubmissionFixture {
  id: string;
  submittedBy: string;
  status: SubmissionStatus;
}

function buildSubmission(input: SubmissionFixture): Submission {
  const manifest: SkillManifest = {
    name: 'demo-skill',
    version: '1.0.0',
    author: input.submittedBy,
    description: 'Demo skill awaiting confirmation',
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
    classification: 'code-containing',
    contentHash: 'sha256:demo',
    submittedAt: '2026-05-26T09:00:00.000Z',
    submittedBy: input.submittedBy,
    status: input.status,
  };
}
