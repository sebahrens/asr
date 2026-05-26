import type { Submission, SubmissionStatus } from '@asr/core';
import type Database from 'better-sqlite3';
import type { Hono } from 'hono';
import type { AuthVariables } from '../../auth/types.js';
import { getSubmissionById, rowToSubmission } from '../../db/repositories/submissions.js';
import { apiError } from '../errors.js';

export interface QuestionnaireResponseInput {
  questionId: string;
  answer: string | boolean;
}

export interface QuestionnaireSignalInput {
  submissionId: string;
  responses: QuestionnaireResponseInput[];
}

export interface QuestionnaireSignalResult {
  scanJobId: string;
}

export type QuestionnaireSignalDeliverer = (
  input: QuestionnaireSignalInput,
) => Promise<QuestionnaireSignalResult> | QuestionnaireSignalResult;

export type QuestionnaireSubmissionLoader = (
  id: string,
) => Promise<Submission | undefined> | Submission | undefined;

export interface QuestionnaireRouteOptions {
  loadSubmission: QuestionnaireSubmissionLoader;
  deliverQuestionnaire: QuestionnaireSignalDeliverer;
}

export function registerQuestionnaireRoute(
  app: Hono<{ Variables: AuthVariables }>,
  options: QuestionnaireRouteOptions,
): void {
  const { loadSubmission, deliverQuestionnaire } = options;

  app.post('/api/v1/submissions/:id/questionnaire', async (c) => {
    const submissionId = c.req.param('id');
    const submission = await loadSubmission(submissionId);
    if (!submission) {
      return apiError(c, 404, 'submission_not_found');
    }

    const body = (await readJson(c.req.raw)) as { responses?: unknown } | undefined;
    if (!body || !Array.isArray(body.responses)) {
      return apiError(c, 400, 'invalid_manifest', {
        message: 'responses must be an array',
      });
    }

    const responses = body.responses.filter(isQuestionnaireResponse);

    const result = await deliverQuestionnaire({
      submissionId,
      responses,
    });

    const status = {
      phase: 'scanning',
      scanJobId: result.scanJobId,
    } satisfies SubmissionStatus;

    return c.json({ status });
  });
}

export function createSqliteSubmissionLoader(db: Database.Database): QuestionnaireSubmissionLoader {
  return (id) => {
    const row = getSubmissionById(db, id);
    return row ? rowToSubmission(row) : undefined;
  };
}

function isQuestionnaireResponse(value: unknown): value is QuestionnaireResponseInput {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as { questionId?: unknown; answer?: unknown };
  return (
    typeof candidate.questionId === 'string' &&
    (typeof candidate.answer === 'string' || typeof candidate.answer === 'boolean')
  );
}

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return undefined;
  }
}
