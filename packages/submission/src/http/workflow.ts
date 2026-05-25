import { ForgejoClient, type ScanReport, type SubmissionStatus, type VersionDiff } from '@asr/core';
import { Hono } from 'hono';
import { apiError } from './errors.js';
import { requireRole } from '../auth/requireRole.js';
import type { AuthVariables, Identity } from '../auth/types.js';
import {
  resumeApprovalPipeline,
  type ApprovalPipelineContext,
  type ApprovalPipelineDependencies,
  type HitlSignal,
} from '../workflow/pipeline.js';

type WorkflowNodeId = 'questionnaire' | 'confirmation' | 'review';

export interface WorkflowSubmissionRecord {
  id: string;
  submittedBy: string;
  serializedContext: string;
  context: ApprovalPipelineContext;
}

export interface WorkflowSubmissionStore {
  get(id: string): Promise<WorkflowSubmissionRecord | undefined> | WorkflowSubmissionRecord | undefined;
  save(record: WorkflowSubmissionRecord): Promise<void> | void;
}

export interface WorkflowRouteOptions {
  store?: WorkflowSubmissionStore;
  dependencies?: ApprovalPipelineDependencies;
  now?: () => Date;
}

class MemoryWorkflowSubmissionStore implements WorkflowSubmissionStore {
  private readonly submissions = new Map<string, WorkflowSubmissionRecord>();

  get(id: string): WorkflowSubmissionRecord | undefined {
    return this.submissions.get(id);
  }

  save(record: WorkflowSubmissionRecord): void {
    this.submissions.set(record.id, record);
  }
}

const defaultStore = new MemoryWorkflowSubmissionStore();

export function createWorkflowRoutes(options: WorkflowRouteOptions = {}) {
  const routes = new Hono<{ Variables: AuthVariables }>();
  const store = options.store ?? defaultStore;
  const dependencies = options.dependencies ?? defaultDependencies();
  const now = options.now ?? (() => new Date());

  routes.post('/:id/questionnaire', requireRole('Submitter'), async (c) => {
    const identity = c.get('identity');
    const record = await store.get(c.req.param('id'));
    if (!record) {
      return apiError(c, 404, 'submission_not_found');
    }
    if (!isSubmitter(record, identity)) {
      return apiError(c, 403, 'insufficient_permissions');
    }

    const body = await readJson(c.req.raw);
    if (!isQuestionnaireBody(body)) {
      return apiError(c, 400, 'invalid_manifest', { message: 'responses must be an array' });
    }

    const result = await resumeAndSave(store, record, 'questionnaire', {
      actor: identity.sub,
      responses: body.responses,
    }, dependencies);

    const report = result.context.scanReport;
    if (report?.verdict === 'block') {
      return c.json({ status: rejectedStatus(now(), 'scan_block') });
    }

    return c.json({ status: { phase: 'scanning', scanJobId: `scan:${record.id}` } satisfies SubmissionStatus });
  });

  routes.get('/:id/scan', async (c) => {
    const identity = c.get('identity');
    const record = await store.get(c.req.param('id'));
    if (!record) {
      return apiError(c, 404, 'submission_not_found');
    }
    if (!canView(record, identity)) {
      return apiError(c, 403, 'insufficient_permissions');
    }

    const report = record.context.scanReport;
    if (!report) {
      return c.json({ status: { phase: 'scanning', scanJobId: `scan:${record.id}` } }, 202);
    }

    return c.json(report);
  });

  routes.get('/:id/diff', async (c) => {
    const identity = c.get('identity');
    const record = await store.get(c.req.param('id'));
    if (!record) {
      return apiError(c, 404, 'submission_not_found');
    }
    if (!canView(record, identity)) {
      return apiError(c, 403, 'insufficient_permissions');
    }

    return c.json((record.context.versionDiff ?? null) satisfies VersionDiff | null);
  });

  routes.post('/:id/confirm', requireRole('Submitter'), async (c) => {
    const identity = c.get('identity');
    const record = await store.get(c.req.param('id'));
    if (!record) {
      return apiError(c, 404, 'submission_not_found');
    }
    if (!isSubmitter(record, identity)) {
      return apiError(c, 403, 'insufficient_permissions');
    }

    await resumeAndSave(store, record, 'confirmation', {
      actor: identity.sub,
      confirmed: true,
    }, dependencies);

    return c.json({ status: { phase: 'compliance-review' } satisfies SubmissionStatus });
  });

  routes.post('/:id/approve', requireRole('Compliance'), async (c) => {
    const identity = c.get('identity');
    const record = await store.get(c.req.param('id'));
    if (!record) {
      return apiError(c, 404, 'submission_not_found');
    }
    if (record.submittedBy === identity.sub) {
      return apiError(c, 403, 'separation_of_duties_violation');
    }

    const result = await resumeAndSave(store, record, 'review', {
      actor: identity.sub,
      decision: 'approved',
    }, dependencies);
    const publishedAt = now().toISOString();
    const status = {
      phase: 'published',
      publishedAt,
      mergeCommit: result.context.mergeCommit ?? '',
    } satisfies SubmissionStatus;

    return c.json({
      status,
      publishedVersion: result.context.manifest.version,
      registryUrl: `/skills/${result.context.manifest.author}/${result.context.manifest.name}`,
    });
  });

  routes.post('/:id/reject', requireRole('Compliance'), async (c) => {
    const identity = c.get('identity');
    const record = await store.get(c.req.param('id'));
    if (!record) {
      return apiError(c, 404, 'submission_not_found');
    }
    if (record.submittedBy === identity.sub) {
      return apiError(c, 403, 'separation_of_duties_violation');
    }

    const body = await readJson(c.req.raw);
    if (!isRejectBody(body)) {
      return apiError(c, 400, 'invalid_manifest', { message: 'reason must be 10-500 characters' });
    }

    await resumeAndSave(store, record, 'review', {
      actor: identity.sub,
      decision: 'rejected',
      reason: body.reason,
    }, dependencies);

    return c.json({ status: rejectedStatus(now(), body.reason) });
  });

  return routes;
}

async function resumeAndSave(
  store: WorkflowSubmissionStore,
  record: WorkflowSubmissionRecord,
  nodeId: WorkflowNodeId,
  signal: HitlSignal,
  dependencies: ApprovalPipelineDependencies,
) {
  const result = await resumeApprovalPipeline(record.serializedContext, signal, nodeId, dependencies);
  await store.save({
    ...record,
    serializedContext: result.serializedContext,
    context: result.context,
  });
  return result;
}

function defaultDependencies(): ApprovalPipelineDependencies {
  return {
    svc(token) {
      if (token !== ForgejoClient) {
        throw new Error('unexpected service token');
      }
      return new ForgejoClient({
        baseUrl: requiredEnv('FORGEJO_API_URL'),
        uploadToken: requiredEnv('FORGEJO_UPLOAD_TOKEN'),
        mergeToken: requiredEnv('FORGEJO_MERGE_TOKEN'),
        owner: requiredEnv('FORGEJO_OWNER'),
        repo: requiredEnv('FORGEJO_REPO'),
      }) as never;
    },
    audit() {},
  };
}

function canView(record: WorkflowSubmissionRecord, identity: Identity): boolean {
  return isSubmitter(record, identity) || identity.roles.some((role) => role === 'Compliance' || role === 'Admin');
}

function isSubmitter(record: WorkflowSubmissionRecord, identity: Identity): boolean {
  return record.submittedBy === identity.sub;
}

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return undefined;
  }
}

function isQuestionnaireBody(value: unknown): value is { responses: unknown[] } {
  return isRecord(value) && Array.isArray(value.responses);
}

function isRejectBody(value: unknown): value is { reason: string } {
  return isRecord(value) && typeof value.reason === 'string' && value.reason.length >= 10 && value.reason.length <= 500;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function rejectedStatus(date: Date, reason: string): SubmissionStatus {
  return { phase: 'rejected', rejectedAt: date.toISOString(), reason };
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}
