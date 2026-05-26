import type { SkillManifest, Submission } from '@asr/core';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import type { AuthVariables, Identity } from '../../auth/types.js';
import {
  registerQuestionnaireRoute,
  type QuestionnaireSignalInput,
  type QuestionnaireSignalResult,
  type QuestionnaireSubmissionLoader,
} from './questionnaire.js';

describe('POST /api/v1/submissions/:id/questionnaire', () => {
  it('delivers the questionnaire HITL signal and returns the scanning status with scan job id', async () => {
    const signalCalls: QuestionnaireSignalInput[] = [];
    const responses = [
      { questionId: 'q1', answer: 'no third-party access' },
      { questionId: 'q2', answer: true },
    ];
    const app = makeApp({
      identity: { sub: 'submitter-1', roles: ['Submitter'] },
      loadSubmission: (id) =>
        id === 'sub-q-ok'
          ? buildSubmission({
              id,
              submittedBy: 'submitter-1',
              status: { phase: 'questionnaire-pending', questionnaireId: 'q-1' },
            })
          : undefined,
      deliverQuestionnaire: (input) => {
        signalCalls.push(input);
        return { scanJobId: 'scan-sub-q-ok' } satisfies QuestionnaireSignalResult;
      },
    });

    const res = await app.request('/api/v1/submissions/sub-q-ok/questionnaire', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ responses }),
    });

    expect(res.status).toBe(200);
    const payload = (await res.json()) as {
      status: { phase: string; scanJobId: string };
    };
    expect(payload.status.phase).toBe('scanning');
    expect(payload.status.scanJobId).toBe('scan-sub-q-ok');
    expect(payload.status.scanJobId.length).toBeGreaterThan(0);
    expect(signalCalls).toEqual([{ submissionId: 'sub-q-ok', responses }]);
  });

  it('returns submission_not_found when the submission id is unknown', async () => {
    const signalCalls: QuestionnaireSignalInput[] = [];
    const app = makeApp({
      identity: { sub: 'submitter-1', roles: ['Submitter'] },
      loadSubmission: () => undefined,
      deliverQuestionnaire: (input) => {
        signalCalls.push(input);
        return { scanJobId: 'never' };
      },
    });

    const res = await app.request('/api/v1/submissions/sub-missing/questionnaire', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ responses: [{ questionId: 'q1', answer: 'yes' }] }),
    });

    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({ error: 'submission_not_found' });
    expect(signalCalls).toEqual([]);
  });

  it('rejects an invalid body where responses is missing or not an array', async () => {
    const signalCalls: QuestionnaireSignalInput[] = [];
    const app = makeApp({
      identity: { sub: 'submitter-1', roles: ['Submitter'] },
      loadSubmission: (id) =>
        id === 'sub-q-bad'
          ? buildSubmission({
              id,
              submittedBy: 'submitter-1',
              status: { phase: 'questionnaire-pending', questionnaireId: 'q-1' },
            })
          : undefined,
      deliverQuestionnaire: (input) => {
        signalCalls.push(input);
        return { scanJobId: 'never' };
      },
    });

    const res = await app.request('/api/v1/submissions/sub-q-bad/questionnaire', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ responses: 'not-an-array' }),
    });

    expect(res.status).toBe(400);
    expect(signalCalls).toEqual([]);
  });

  interface MakeAppInput {
    identity: Identity;
    loadSubmission: QuestionnaireSubmissionLoader;
    deliverQuestionnaire: (
      input: QuestionnaireSignalInput,
    ) => QuestionnaireSignalResult | Promise<QuestionnaireSignalResult>;
  }

  function makeApp(input: MakeAppInput): Hono<{ Variables: AuthVariables }> {
    const app = new Hono<{ Variables: AuthVariables }>();
    app.use('*', async (c, next) => {
      c.set('identity', input.identity);
      await next();
    });

    registerQuestionnaireRoute(app, {
      loadSubmission: input.loadSubmission,
      deliverQuestionnaire: input.deliverQuestionnaire,
    });

    return app;
  }
});

interface SubmissionFixture {
  id: string;
  submittedBy: string;
  status: Submission['status'];
}

function buildSubmission(input: SubmissionFixture): Submission {
  const manifest: SkillManifest = {
    name: 'demo-skill',
    version: '1.0.0',
    author: input.submittedBy,
    description: 'Demo skill awaiting questionnaire',
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
