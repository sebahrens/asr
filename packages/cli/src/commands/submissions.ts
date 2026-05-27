import { Command } from 'commander';
import pc from 'picocolors';
import type { SkillManifest } from '@asr/core';
import type { FetchLike } from '../auth/device-code.js';
import { ApiError, apiFetch } from '../api.js';

type StatusPhase = string;

interface SubmissionStatusObject {
  phase: StatusPhase;
  [key: string]: unknown;
}

type SubmissionStatusField = StatusPhase | SubmissionStatusObject;

export interface SubmissionDetail {
  id: string;
  status: SubmissionStatusField;
  createdAt?: string;
  manifest?: Partial<SkillManifest> & { name?: string; version?: string };
  contentHash?: string;
  classification?: string;
  submittedBy?: string;
  prNumber?: number;
  branchName?: string;
  [key: string]: unknown;
}

export interface SubmissionSummary {
  id: string;
  status: SubmissionStatusField;
  createdAt?: string;
  manifest?: { name?: string; version?: string };
}

export interface RunOptions {
  fetch?: FetchLike;
  baseUrl?: string;
  log?: (message: string) => void;
  errorLog?: (message: string) => void;
}

function defaultLog(m: string): void {
  console.log(m);
}

function defaultErrorLog(m: string): void {
  console.error(m);
}

function phaseOf(status: SubmissionStatusField | undefined): string {
  if (!status) return 'unknown';
  if (typeof status === 'string') return status;
  return status.phase ?? 'unknown';
}

function formatField(label: string, value: string | undefined): string {
  return `${pc.dim(label.padEnd(12))} ${value ?? '-'}`;
}

export async function runStatus(
  submissionId: string,
  opts: RunOptions = {},
): Promise<void> {
  const log = opts.log ?? defaultLog;
  const errorLog = opts.errorLog ?? defaultErrorLog;
  if (!submissionId) {
    errorLog(pc.red('Missing submission id'));
    process.exit(1);
  }

  let detail: SubmissionDetail;
  try {
    detail = await apiFetch<SubmissionDetail>(
      `/api/v1/submissions/${encodeURIComponent(submissionId)}`,
      { fetch: opts.fetch, baseUrl: opts.baseUrl },
    );
  } catch (err) {
    if (err instanceof ApiError) {
      const reason = typeof err.body.error === 'string' ? err.body.error : err.message;
      errorLog(pc.red(`Failed (${err.status}): ${reason}`));
    } else {
      errorLog(pc.red(err instanceof Error ? err.message : String(err)));
    }
    process.exit(1);
  }

  log(formatField('id', detail.id));
  log(formatField('phase', phaseOf(detail.status)));
  if (detail.createdAt) log(formatField('createdAt', detail.createdAt));
  if (detail.manifest?.name) log(formatField('skill', detail.manifest.name));
  if (detail.manifest?.version) log(formatField('version', detail.manifest.version));
  if (detail.classification) log(formatField('class', detail.classification));
  if (detail.contentHash) log(formatField('hash', detail.contentHash));
  if (detail.submittedBy) log(formatField('submitter', detail.submittedBy));
  if (detail.prNumber !== undefined) log(formatField('prNumber', String(detail.prNumber)));
  if (detail.branchName) log(formatField('branch', detail.branchName));
}

function extractList(body: unknown): SubmissionSummary[] {
  if (Array.isArray(body)) return body as SubmissionSummary[];
  if (body && typeof body === 'object') {
    const obj = body as Record<string, unknown>;
    if (Array.isArray(obj.submissions)) return obj.submissions as SubmissionSummary[];
    if (Array.isArray(obj.items)) return obj.items as SubmissionSummary[];
  }
  return [];
}

export async function runSubmissions(opts: RunOptions = {}): Promise<void> {
  const log = opts.log ?? defaultLog;
  const errorLog = opts.errorLog ?? defaultErrorLog;

  let body: unknown;
  try {
    body = await apiFetch('/api/v1/submissions', {
      fetch: opts.fetch,
      baseUrl: opts.baseUrl,
    });
  } catch (err) {
    if (err instanceof ApiError) {
      const reason = typeof err.body.error === 'string' ? err.body.error : err.message;
      errorLog(pc.red(`Failed (${err.status}): ${reason}`));
    } else {
      errorLog(pc.red(err instanceof Error ? err.message : String(err)));
    }
    process.exit(1);
  }

  const rows = extractList(body);
  if (rows.length === 0) {
    log('No submissions.');
    return;
  }

  log(`${pc.bold('id'.padEnd(28))}  ${pc.bold('phase'.padEnd(26))}  ${pc.bold('createdAt')}`);
  for (const row of rows) {
    const id = (row.id ?? '').padEnd(28);
    const phase = phaseOf(row.status).padEnd(26);
    const createdAt = row.createdAt ?? '-';
    log(`${id}  ${phase}  ${createdAt}`);
  }
}

export function registerStatus(program: Command): void {
  program
    .command('status <submission-id>')
    .description('Show submission detail (id, current workflow phase, key fields)')
    .action(async (submissionId: string) => {
      await runStatus(submissionId);
    });
}

export function registerSubmissions(program: Command): void {
  program
    .command('submissions')
    .description('List your submissions (id, phase, createdAt)')
    .action(async () => {
      await runSubmissions();
    });
}
