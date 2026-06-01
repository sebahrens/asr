import { ForgejoClient, type ScanReport, type SkillManifest, type Submission, type SubmissionStatus, type VersionDiff } from '@asr/core';
import type Database from 'better-sqlite3';
import { Hono } from 'hono';
import { apiError } from './errors.js';
import { requireRole } from '../auth/requireRole.js';
import { SeparationOfDutiesError, assertSeparation } from '../auth/separation.js';
import type { AuthVariables, Identity } from '../auth/types.js';
import { getSkillVersion, insertSkillVersion } from '../db/repositories/skillVersions.js';
import {
  updateSubmissionStatusIfCurrent,
} from '../db/repositories/submissions.js';
import { forgejoFromEnv } from '../forgejo/index.js';
import { ownerFromPrincipal } from '../identity/owners.js';
import {
  getWorkflowRun,
  listWorkflowRuns,
  saveWorkflowRun,
} from '../db/repositories/workflowRuns.js';
import {
  resumeApprovalPipeline,
  runApprovalPipeline,
  type ApprovalPipelineContext,
  type ApprovalPipelineDependencies,
  type HitlSignal,
} from '../workflow/approvalPipeline.js';
import { releasePendingVersion } from '../workflow/pendingVersionLock.js';

type WorkflowNodeId = 'questionnaire' | 'confirmation' | 'review';

const terminalWorkflowPhases = new Set<string>(['published', 'rejected', 'withdrawn', 'error']);
const DEFAULT_SUBMISSIONS_PAGE_SIZE = 50;
const MAX_SUBMISSIONS_PAGE_SIZE = 100;

export interface WorkflowSubmissionRecord {
  id: string;
  submittedBy: string;
  serializedContext: string;
  context: ApprovalPipelineContext;
  submissionLockVersion?: number;
  submissionStatusPhase?: string;
}

export interface WorkflowSubmissionStore {
  get(id: string): Promise<WorkflowSubmissionRecord | undefined> | WorkflowSubmissionRecord | undefined;
  list?(): Promise<WorkflowSubmissionRecord[]> | WorkflowSubmissionRecord[];
  save(record: WorkflowSubmissionRecord): Promise<void> | void;
}

export interface WorkflowRouteOptions {
  store?: WorkflowSubmissionStore;
  db?: Database.Database;
  dependencies?: ApprovalPipelineDependencies;
  now?: () => Date;
  regenerateRegistryIndex?: () => Promise<void> | void;
}

class MemoryWorkflowSubmissionStore implements WorkflowSubmissionStore {
  private readonly submissions = new Map<string, WorkflowSubmissionRecord>();

  get(id: string): WorkflowSubmissionRecord | undefined {
    return this.submissions.get(id);
  }

  list(): WorkflowSubmissionRecord[] {
    return Array.from(this.submissions.values());
  }

  save(record: WorkflowSubmissionRecord): void {
    this.submissions.set(record.id, record);
  }
}

const defaultStore = new MemoryWorkflowSubmissionStore();
seedDefaultStore(defaultStore);

class SqliteWorkflowSubmissionStore implements WorkflowSubmissionStore {
  constructor(
    private readonly db: Database.Database,
    private readonly now: () => Date,
  ) {}

  get(id: string): WorkflowSubmissionRecord | undefined {
    return getWorkflowRun(this.db, id);
  }

  list(): WorkflowSubmissionRecord[] {
    return listWorkflowRuns(this.db);
  }

  save(record: WorkflowSubmissionRecord): void {
    saveWorkflowRun(this.db, record, this.now());
  }
}

export function createWorkflowRoutes(options: WorkflowRouteOptions = {}) {
  const routes = new Hono<{ Variables: AuthVariables }>();
  const now = options.now ?? (() => new Date());
  const store = options.store ?? (options.db ? new SqliteWorkflowSubmissionStore(options.db, now) : defaultStore);
  const dependencies = options.dependencies ?? defaultDependencies();

  routes.get('/', requireRole('Submitter', 'Compliance', 'Admin'), async (c) => {
    const identity = c.get('identity');
    const records = store.list ? await store.list() : [];
    const requestedStatus = c.req.query('status');
    const page = parseSubmissionsPage(c.req.query('limit'), c.req.query('cursor'));
    const matchingSubmissions = records
      .filter((record) => canView(record, identity))
      .map(toReviewSubmission)
      .filter((submission) => requestedStatus !== 'pending' || submission.status === 'pending review');
    const submissions = matchingSubmissions.slice(page.offset, page.offset + page.limit);
    const nextOffset = page.offset + submissions.length;
    const nextCursor = nextOffset < matchingSubmissions.length ? String(nextOffset) : null;

    return c.json({ submissions, nextCursor });
  });

  routes.get('/:id', requireRole('Submitter', 'Compliance', 'Admin'), async (c) => {
    const identity = c.get('identity');
    const record = await store.get(c.req.param('id'));
    if (!record) {
      return apiError(c, 404, 'submission_not_found');
    }
    if (!canView(record, identity)) {
      return apiError(c, 403, 'insufficient_permissions');
    }

    return c.json(record.context.submission);
  });

  routes.post('/:id/questionnaire', requireRole('Submitter'), async (c) => {
    const identity = c.get('identity');
    const record = await store.get(c.req.param('id'));
    if (!record) {
      return apiError(c, 404, 'submission_not_found');
    }
    if (!isSubmitter(record, identity)) {
      return apiError(c, 403, 'insufficient_permissions');
    }
    if (isTerminalWorkflowRecord(record)) {
      return terminalStateError(c, record);
    }

    const body = await readJson(c.req.raw);
    if (!isQuestionnaireBody(body)) {
      return apiError(c, 400, 'invalid_manifest', { message: 'responses must be an array' });
    }

    const result = await resumeAndSave(options, store, record, 'questionnaire', {
      actor: identity.sub,
      roles: identity.roles,
      responses: body.responses,
    }, dependencies, now);
    if (!result) {
      return staleSubmissionError(c);
    }

    return c.json({ status: result.context.submission.status });
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
    if (isTerminalWorkflowRecord(record)) {
      return terminalStateError(c, record);
    }

    const result = await resumeAndSave(options, store, record, 'confirmation', {
      actor: identity.sub,
      roles: identity.roles,
      confirmed: true,
    }, dependencies, now);
    if (!result) {
      return staleSubmissionError(c);
    }

    return c.json({ status: result.context.submission.status });
  });

  routes.post('/:id/approve', requireRole('Compliance'), async (c) => {
    const identity = c.get('identity');
    const record = await store.get(c.req.param('id'));
    if (!record) {
      return apiError(c, 404, 'submission_not_found');
    }
    try {
      assertSeparation(record.submittedBy, identity.sub);
    } catch (err) {
      if (err instanceof SeparationOfDutiesError) {
        return apiError(c, 403, 'separation_of_duties_violation');
      }
      throw err;
    }
    if (isTerminalWorkflowRecord(record)) {
      return terminalStateError(c, record);
    }

    if (record.serializedContext === '{}') {
      return apiError(c, 409, 'submission_not_ready', {
        message: 'submission has not entered the approval pipeline',
      });
    }

    const result = await resumeAndSave(options, store, record, 'review', {
      actor: identity.sub,
      roles: identity.roles,
      decision: 'approved',
    }, dependencies, now);
    if (!result) {
      return staleSubmissionError(c);
    }
    const publishedAt = now().toISOString();
    const status = {
      phase: 'published',
      publishedAt,
      mergeCommit: result.context.mergeCommit ?? '',
    } satisfies SubmissionStatus;

    return c.json({
      status,
      publishedVersion: result.context.manifest.version,
      registryUrl: `/skills/${ownerFromPrincipal(record.submittedBy)}/${result.context.manifest.name}`,
    });
  });

  routes.post('/:id/reject', requireRole('Compliance'), async (c) => {
    const identity = c.get('identity');
    const record = await store.get(c.req.param('id'));
    if (!record) {
      return apiError(c, 404, 'submission_not_found');
    }
    try {
      assertSeparation(record.submittedBy, identity.sub);
    } catch (err) {
      if (err instanceof SeparationOfDutiesError) {
        return apiError(c, 403, 'separation_of_duties_violation');
      }
      throw err;
    }
    if (isTerminalWorkflowRecord(record)) {
      return terminalStateError(c, record);
    }

    const body = await readJson(c.req.raw);
    if (!isRejectBody(body)) {
      return apiError(c, 400, 'invalid_manifest', { message: 'reason must be 10-500 characters' });
    }

    const result = await resumeAndSave(options, store, record, 'review', {
      actor: identity.sub,
      roles: identity.roles,
      decision: 'rejected',
      reason: body.reason,
    }, dependencies, now);
    if (!result) {
      return staleSubmissionError(c);
    }

    return c.json({ status: rejectedStatus(now(), body.reason) });
  });

  return routes;
}

function toReviewSubmission(record: WorkflowSubmissionRecord) {
  const manifest = record.context.manifest;
  const status = toReviewStatus(record.context.status ?? record.context.submission.status.phase);
  const findings = record.context.scanReport?.findings.length ?? 0;

  return {
    id: record.id,
    skillName: manifest.name,
    owner: ownerFromPrincipal(record.submittedBy),
    version: manifest.version,
    submitter: record.submittedBy,
    submittedBy: record.submittedBy,
    submitterSub: record.submittedBy,
    submittedAt: record.context.submission.submittedAt,
    status,
    risk: toRisk(record.context.versionDiff?.riskAssessment, findings),
    findings,
  };
}

function toReviewStatus(phase: NonNullable<ApprovalPipelineContext['status']>) {
  switch (phase) {
    case 'compliance-review':
      return 'pending review';
    case 'scanning':
      return 'scanning';
    case 'user-confirmation-pending':
      return 'awaiting confirmation';
    case 'published':
      return 'approved';
    case 'rejected':
      return 'rejected';
    default:
      return 'scanning';
  }
}

function toRisk(risk: VersionDiff['riskAssessment'] | undefined, findings: number) {
  if (risk) {
    return risk;
  }
  if (findings > 5) {
    return 'high';
  }
  if (findings > 0) {
    return 'medium';
  }
  return 'low';
}

async function resumeAndSave(
  options: WorkflowRouteOptions,
  store: WorkflowSubmissionStore,
  record: WorkflowSubmissionRecord,
  nodeId: WorkflowNodeId,
  signal: HitlSignal,
  dependencies: ApprovalPipelineDependencies,
  now: () => Date,
) {
  const result = await resumeApprovalPipeline(record.serializedContext, signal, nodeId, dependencies);
  const status = statusFromWorkflowResult(record.id, result.context, now);
  const context = {
    ...result.context,
    status: status.phase,
    submission: {
      ...result.context.submission,
      status,
    },
  };
  if (options.db) {
    const db = options.db;
    const persisted = persistWorkflowResume(db, record, result.serializedContext, context, status, now);
    if (!persisted) {
      return undefined;
    }
    if (status.phase === 'published') {
      await options.regenerateRegistryIndex?.();
    }
  } else {
    await store.save({
      ...record,
      serializedContext: result.serializedContext,
      context,
    });
  }
  return { ...result, context };
}

function persistWorkflowResume(
  db: Database.Database,
  record: WorkflowSubmissionRecord,
  serializedContext: string,
  context: ApprovalPipelineContext,
  status: SubmissionStatus,
  now: () => Date,
): boolean {
  return db.transaction(() => {
    const expectedLockVersion = record.submissionLockVersion;
    const expectedStatusPhase = record.submissionStatusPhase ?? currentWorkflowPhase(record);
    if (expectedLockVersion === undefined || expectedStatusPhase === undefined) {
      return false;
    }

    const updated = updateSubmissionStatusIfCurrent(db, record.id, expectedLockVersion, {
      statusPhase: status.phase,
      statusJson: JSON.stringify(status),
      expectedStatusPhase,
    });
    if (!updated) {
      return false;
    }

    saveWorkflowRun(db, {
      ...record,
      serializedContext,
      context,
    }, now());
    if (isTerminalSubmissionStatus(status) && status.phase === 'published') {
      persistPublishedVersion(db, record.id, record.submittedBy, context, status);
    }
    if (isTerminalSubmissionStatus(status)) {
      releasePendingVersion(db, context.manifest.name, context.manifest.version);
    }
    return true;
  })();
}

function isTerminalSubmissionStatus(status: SubmissionStatus): boolean {
  return status.phase === 'published' || status.phase === 'rejected' || status.phase === 'withdrawn';
}

function persistPublishedVersion(
  db: Database.Database,
  submissionId: string,
  submittedBy: string,
  context: ApprovalPipelineContext,
  status: Extract<SubmissionStatus, { phase: 'published' }>,
): void {
  const manifest = context.manifest;
  const owner = ownerFromPrincipal(submittedBy);
  if (getSkillVersion(db, manifest.name, manifest.version, owner)) {
    return;
  }

  insertSkillVersion(db, {
    owner,
    skill_name: manifest.name,
    version: manifest.version,
    content_hash: context.contentHash,
    submission_id: submissionId,
    published_at: status.publishedAt,
    published_by: submittedBy,
    approved_by: context.review?.actor ?? null,
    pr_number: context.prNumber ?? 0,
    merge_commit: status.mergeCommit,
    scan_report_id: null,
    yanked_at: null,
    yanked_by: null,
    yank_reason: null,
  });
}

function statusFromWorkflowResult(
  submissionId: string,
  context: ApprovalPipelineContext,
  now: () => Date,
): SubmissionStatus {
  if (context.status === 'published') {
    return {
      phase: 'published',
      publishedAt: now().toISOString(),
      mergeCommit: context.mergeCommit ?? '',
    };
  }

  if (context.status === 'rejected') {
    return {
      phase: 'rejected',
      rejectedAt: now().toISOString(),
      reason: context.review?.reason ?? 'scan_block',
    };
  }

  const awaiting = context._awaitingNodeIds?.[0];
  if (awaiting === 'questionnaire') {
    return { phase: 'questionnaire-pending', questionnaireId: `questionnaire:${submissionId}` };
  }
  if (awaiting === 'confirmation') {
    return { phase: 'user-confirmation-pending' };
  }
  if (awaiting === 'review') {
    return { phase: 'compliance-review' };
  }

  return { phase: 'uploaded' };
}

function defaultDependencies(): ApprovalPipelineDependencies {
  return {
    svc(token) {
      if (token !== ForgejoClient) {
        throw new Error('unexpected service token');
      }
      return forgejoFromEnv() as never;
    },
    audit() {},
  };
}

function seedDefaultStore(store: MemoryWorkflowSubmissionStore): void {
  if (process.env.NODE_ENV !== 'development' || process.env.AUTH_MODE !== 'mock') {
    return;
  }

  if (store.list().length) {
    return;
  }

  for (const record of createDevelopmentReviewQueue()) {
    void store.save(record);
  }
}

function createDevelopmentReviewQueue(): WorkflowSubmissionRecord[] {
  return [
    createDevelopmentReviewRecord({
      id: 'sub-1042',
      owner: 'platform',
      skillName: 'secure-code-review',
      version: '1.4.0',
      submittedBy: 'maria.chen',
      submittedAt: '2026-05-24T08:35:00.000Z',
      riskAssessment: 'high',
      findings: [
        {
          tool: 'gitleaks',
          ruleId: 'possible-secret',
          severity: 'high',
          file: 'scripts/review.ts',
          line: 18,
          message: 'Potential token-like value requires manual review.',
        },
        {
          tool: 'opengrep',
          ruleId: 'shell-command',
          severity: 'medium',
          file: 'scripts/review.ts',
          line: 42,
          message: 'Shell execution path needs policy confirmation.',
        },
        {
          tool: 'trivy',
          ruleId: 'dependency-cve',
          severity: 'medium',
          file: 'package.json',
          line: 12,
          message: 'Dependency version has a review-required advisory.',
        },
      ],
    }),
    createDevelopmentReviewRecord({
      id: 'sub-1039',
      owner: 'docs',
      skillName: 'release-notes',
      version: '0.8.2',
      submittedBy: 'eli.warner',
      submittedAt: '2026-05-23T17:10:00.000Z',
      riskAssessment: 'medium',
      findings: [
        {
          tool: 'opengrep',
          ruleId: 'network-reference',
          severity: 'medium',
          file: 'SKILL.md',
          line: 27,
          message: 'External release-note source requires reviewer approval.',
        },
      ],
    }),
  ];
}

function createDevelopmentReviewRecord(input: {
  id: string;
  owner: string;
  skillName: string;
  version: string;
  submittedBy: string;
  submittedAt: string;
  riskAssessment: VersionDiff['riskAssessment'];
  findings: ScanReport['findings'];
}): WorkflowSubmissionRecord {
  const contentHash = `sha256:dev-${input.id}`;
  const manifest: SkillManifest = {
    name: input.skillName,
    version: input.version,
    author: input.owner,
    description: `Development fixture for reviewing ${input.skillName}.`,
    tags: ['dev', 'review'],
    kind: 'skill',
    permissions: {
      network: false,
      filesystem: 'read-own',
      subprocess: false,
      environment: [],
    },
  };
  const submission: Submission = {
    id: input.id,
    manifest,
    classification: 'code-containing',
    contentHash,
    submittedAt: input.submittedAt,
    submittedBy: input.submittedBy,
    status: { phase: 'compliance-review' },
  };

  return {
    id: input.id,
    submittedBy: input.submittedBy,
    serializedContext: '{}',
    context: {
      submissionId: input.id,
      submission,
      manifest,
      files: [{ path: 'SKILL.md', contentBase64: Buffer.from(`# ${input.skillName}`).toString('base64') }],
      contentHash,
      extractedDir: `/tmp/${input.id}`,
      zipBufferBase64: Buffer.from('dev archive').toString('base64'),
      status: 'compliance-review',
      scanReport: {
        submissionId: input.id,
        scanId: `scan-${input.id}`,
        contentHash,
        scannerImage: 'registry.local/asr/scanner:dev',
        startedAt: input.submittedAt,
        completedAt: input.submittedAt,
        durationMs: 1000,
        verdict: 'review_required',
        findings: input.findings,
        toolResults: {
          gitleaks: { exitCode: 0, findingCount: input.findings.filter((finding) => finding.tool === 'gitleaks').length },
          trivy: { exitCode: 0, findingCount: input.findings.filter((finding) => finding.tool === 'trivy').length },
          foxguard: { exitCode: 0, findingCount: input.findings.filter((finding) => finding.tool === 'foxguard').length },
          opengrep: { exitCode: 0, findingCount: input.findings.filter((finding) => finding.tool === 'opengrep').length },
          veracode: { exitCode: 0, findingCount: input.findings.filter((finding) => finding.tool === 'veracode').length, skipped: true },
        },
      },
      versionDiff: {
        skillName: input.skillName,
        fromVersion: '0.0.0',
        toVersion: input.version,
        fromContentHash: null,
        toContentHash: contentHash,
        filesAdded: ['SKILL.md'],
        filesRemoved: [],
        filesModified: [],
        dependenciesAdded: {},
        dependenciesRemoved: {},
        dependenciesChanged: {},
        permissionsBefore: null,
        permissionsAfter: manifest.permissions,
        permissionsExpanded: false,
        manifestKindChanged: false,
        riskAssessment: input.riskAssessment,
        computedAt: input.submittedAt,
      },
    },
  };
}

function canView(record: WorkflowSubmissionRecord, identity: Identity): boolean {
  return isSubmitter(record, identity) || identity.roles.some((role) => role === 'Compliance' || role === 'Admin');
}

function isSubmitter(record: WorkflowSubmissionRecord, identity: Identity): boolean {
  return identity.sub === record.submittedBy;
}

function currentWorkflowPhase(record: WorkflowSubmissionRecord): string | undefined {
  return record.submissionStatusPhase ?? record.context.status ?? record.context.submission.status.phase;
}

function isTerminalWorkflowRecord(record: WorkflowSubmissionRecord): boolean {
  const phase = currentWorkflowPhase(record);
  return phase !== undefined && terminalWorkflowPhases.has(phase);
}

function parseSubmissionsPage(
  limitValue: string | undefined,
  cursorValue: string | undefined,
): { limit: number; offset: number } {
  const limit = Number(limitValue);
  const offset = Number(cursorValue);

  return {
    limit: Number.isInteger(limit) && limit > 0
      ? Math.min(limit, MAX_SUBMISSIONS_PAGE_SIZE)
      : DEFAULT_SUBMISSIONS_PAGE_SIZE,
    offset: Number.isInteger(offset) && offset > 0 ? offset : 0,
  };
}

function terminalStateError(c: Parameters<typeof apiError>[0], record: WorkflowSubmissionRecord): Response {
  const phase = currentWorkflowPhase(record) ?? 'unknown';
  return apiError(c, 409, 'submission_not_in_expected_state', {
    message: `submission is already ${phase}`,
  });
}

function staleSubmissionError(c: Parameters<typeof apiError>[0]): Response {
  return apiError(c, 409, 'submission_not_in_expected_state', {
    message: 'submission state changed while the workflow was resuming',
  });
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
