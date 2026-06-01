import {
  canonicalHashFromDigests,
  computeVersionDiff,
  parseSkillManifest,
  selectApprovalPath,
  validateVersionUpgrade,
  ForgejoClient,
  type ApprovalPath,
  type ScreeningReport,
  type SkillManifest,
  type Submission,
  type SubmissionStatus,
  type VersionSnapshot,
} from '@asr/core';
import type Database from 'better-sqlite3';
import { Hono } from 'hono';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import { ulid } from 'ulid';
import type { AuthVariables, Identity } from '../auth/types.js';
import {
  getSkillVersion,
  resolveLatestVersion,
} from '../db/repositories/skillVersions.js';
import { publishSubmissionVersion } from '../db/repositories/publishedSubmissions.js';
import {
  getSubmissionById,
  insertSubmission,
  rowToSubmission,
  updateSubmissionStatus,
  type SubmissionInsertRow,
} from '../db/repositories/submissions.js';
import { insertVersionDiff } from '../db/repositories/versionDiffs.js';
import { findSubmissionIdByContentHash, getBlockedHash } from '../db/repositories/versions.js';
import { getWorkflowRun, saveWorkflowRun } from '../db/repositories/workflowRuns.js';
import { forgejoFromEnv } from '../forgejo/index.js';
import { ownerFromPrincipal } from '../identity/owners.js';
import { requireRole } from '../auth/requireRole.js';
import { emitAudit } from '../audit/emit.js';
import {
  acquirePendingVersion,
  releasePendingVersion,
} from '../workflow/pendingVersionLock.js';
import { LockVersionMismatchError } from '../workflow/errors.js';
import {
  runApprovalPipeline,
  type ApprovalPipelineContext,
  type ApprovalPipelineDependencies,
} from '../workflow/approvalPipeline.js';
import { classifySkill } from '../zip/classify.js';
import { extractSafe } from '../zip/extract.js';
import { apiError } from './errors.js';

export type SubmissionPersist = (row: SubmissionInsertRow) => void | Promise<void>;
export type SubmissionLookup = (
  id: string,
) => Submission | undefined | Promise<Submission | undefined>;
export type GetPriorFiles = (
  skillName: string,
  version: string,
  owner: string,
) => Promise<Array<{ path: string; content: Buffer }> | null | undefined>;

export interface SubmissionRouteOptions {
  db?: Database.Database;
  persist?: SubmissionPersist;
  lookup?: SubmissionLookup;
  fallthroughNotFound?: boolean;
  now?: () => Date;
  generateId?: () => string;
  forgejo?: ForgejoClient;
  getPriorFiles?: GetPriorFiles;
  triggerMarketplaceSync?: (skillName: string) => Promise<void>;
  workflowDependencies?: ApprovalPipelineDependencies;
}

interface UploadedFile {
  arrayBuffer(): Promise<ArrayBuffer>;
  stream?: () => NodeReadableStream<Uint8Array>;
  size: number;
}

interface FileDigestEntry {
  path: string;
  size: number;
  sha256: Buffer;
}

class PendingVersionContentionError extends Error {
  constructor() {
    super('pending version contention');
    this.name = 'PendingVersionContentionError';
  }
}

export function createSubmissionRoutes(options: SubmissionRouteOptions = {}) {
  const routes = new Hono<{ Variables: AuthVariables }>();
  const now = options.now ?? (() => new Date());
  const generateId = options.generateId ?? (() => ulid());
  const persist: SubmissionPersist | undefined = options.persist;
  const lookup: SubmissionLookup | undefined =
    options.lookup ??
    (options.db
      ? (id) => {
          const row = getSubmissionById(options.db!, id);
          return row ? rowToSubmission(row) : undefined;
        }
      : undefined);

  routes.delete('/:id', requireRole('Submitter'), async (c) => {
    const identity = c.get('identity');
    if (!identity) {
      return apiError(c, 401, 'authentication_required');
    }

    const id = c.req.param('id');
    const row = options.db ? getSubmissionById(options.db, id) : undefined;
    const submission = row ? rowToSubmission(row) : lookup ? await lookup(id) : undefined;
    if (!submission) {
      return apiError(c, 404, 'submission_not_found');
    }
    if (submission.submittedBy !== identity.sub) {
      return apiError(c, 403, 'insufficient_permissions');
    }
    if (isTerminalSubmissionStatus(submission.status)) {
      return apiError(c, 409, 'submission_not_in_expected_state');
    }
    if (!options.db || !row) {
      return apiError(c, 503, 'internal_error', {
        message: 'submission withdrawal requires a database-backed route',
      });
    }

    const withdrawnAt = now().toISOString();
    const nextStatus: SubmissionStatus = { phase: 'withdrawn', withdrawnAt };
    const manifest = submission.manifest;

    const updated = options.db.transaction(() => {
      const ok = updateSubmissionStatus(options.db!, id, row.lock_version, {
        statusPhase: nextStatus.phase,
        statusJson: JSON.stringify(nextStatus),
      });
      if (!ok) {
        return false;
      }
      const workflowRun = getWorkflowRun(options.db!, id);
      if (workflowRun) {
        saveWorkflowRun(options.db!, {
          ...workflowRun,
          context: {
            ...workflowRun.context,
            status: nextStatus.phase,
            submission: {
              ...workflowRun.context.submission,
              status: nextStatus,
            },
          },
        }, now());
      }
      releasePendingVersion(options.db!, manifest.name, manifest.version);
      emitAudit(options.db!, {
        action: 'submission.withdrawn',
        submissionId: id,
        skillName: manifest.name,
        version: manifest.version,
        actor: identity.sub,
        actorType: 'user',
        detail: { reason: 'submitter_withdrawal' },
      });
      return true;
    })();

    if (!updated) {
      return apiError(c, 409, 'submission_in_progress');
    }

    return c.json({ status: nextStatus });
  });

  routes.get('/:id/screening', requireRole('Submitter', 'Compliance', 'Admin'), async (c) => {
    const identity = c.get('identity');
    if (!identity) {
      return apiError(c, 401, 'authentication_required');
    }

    const id = c.req.param('id');
    const submission = lookup ? await lookup(id) : undefined;
    if (!submission) {
      return apiError(c, 404, 'submission_not_found');
    }
    if (!canViewSubmission(submission, identity)) {
      return apiError(c, 403, 'insufficient_permissions');
    }
    if (!options.db) {
      return apiError(c, 404, 'submission_not_found', {
        message: 'screening report not found',
      });
    }

    const report = getWorkflowRun(options.db, id)?.context.screeningReport;
    if (!report) {
      return apiError(c, 404, 'submission_not_found', {
        message: 'screening report not found',
      });
    }

    return c.json(report satisfies ScreeningReport);
  });

  routes.get('/:id', requireRole('Submitter', 'Compliance', 'Admin'), async (c, next) => {
    const identity = c.get('identity');
    if (!identity) {
      return apiError(c, 401, 'authentication_required');
    }

    const id = c.req.param('id');
    const submission = lookup ? await lookup(id) : undefined;
    if (!submission) {
      if (options.fallthroughNotFound === true) {
        await next();
        if (c.res.status !== 404) {
          return c.res;
        }
      }
      return apiError(c, 404, 'submission_not_found');
    }
    if (!canViewSubmission(submission, identity)) {
      return apiError(c, 403, 'insufficient_permissions');
    }
    return c.json(submission);
  });

  routes.post('/', requireRole('Submitter', 'Admin'), async (c, next) => {
    if (!isMultipartContentType(c.req.header('content-type'))) {
      return next();
    }

    let body: Record<string, unknown>;
    try {
      body = (await c.req.parseBody()) as Record<string, unknown>;
    } catch {
      return next();
    }

    const file = body.file;
    if (!isUploadedFile(file)) {
      return next();
    }

    const tempRoot = await mkdtemp(join(tmpdir(), 'asr-submission-'));
    const zipPath = join(tempRoot, 'upload.zip');
    const extractedDir = join(tempRoot, 'extracted');

    try {
      await writeUploadedFile(file, zipPath);

      let files: string[];
      try {
        files = await extractSafe(zipPath, extractedDir);
      } catch (error) {
        return apiError(c, 400, 'invalid_zip', {
          message: error instanceof Error ? error.message : 'failed to extract zip',
        });
      }

      const skillMdEntry = files.find((path) => path === 'SKILL.md');
      if (!skillMdEntry) {
        return apiError(c, 422, 'invalid_manifest', {
          message: 'SKILL.md is required at the root of the archive',
        });
      }

      const classification = classifySkill(files);
      const skillMdContent = await readFile(join(extractedDir, skillMdEntry), 'utf8');

      let manifest;
      try {
        ({ manifest } = parseSkillManifest(skillMdContent));
      } catch (error) {
        return apiError(c, 422, 'invalid_manifest', {
          message: error instanceof Error ? error.message : 'failed to parse SKILL.md',
        });
      }

      const fileDigests = await hashExtractedFiles(files, extractedDir);
      const contentHash = canonicalHashFromDigests(fileDigests);

      const db = options.db;
      let currentVersion: string | undefined;
      let versionDiff: ReturnType<typeof computeVersionDiff> | undefined;
      let approvalPath: ApprovalPath | undefined;
      const identity = c.get('identity');
      if (!identity) {
        return apiError(c, 401, 'authentication_required');
      }
      const submittedBy = identity.sub;
      if (submittedBy.trim() === '') {
        return apiError(c, 401, 'authentication_required');
      }
      const owner = ownerFromPrincipal(submittedBy);

      if (db) {
        const blocked = getBlockedHash(db, contentHash);
        if (blocked) {
          return apiError(c, 409, 'content_blocked', {
            details: { source: blocked.source, reason: blocked.reason },
          });
        }
        const existingSubmissionId = findSubmissionIdByContentHash(db, contentHash);
        if (existingSubmissionId) {
          return apiError(c, 409, 'content_blocked', {
            details: { reason: 'duplicate_content', existingSubmissionId },
          });
        }

        currentVersion = resolveLatestVersion(db, manifest.name, owner);

        if (currentVersion !== undefined) {
          const upgrade = validateVersionUpgrade(manifest.version, currentVersion);
          if (!upgrade.ok) {
            const apiCode =
              upgrade.error === 'invalid_format' ? 'invalid_version' : 'version_not_greater';
            return apiError(c, 409, apiCode, {
              details: {
                name: manifest.name,
                next: manifest.version,
                current: currentVersion,
              },
            });
          }

          const priorSnapshot = await buildPriorSnapshot(
            db,
            manifest.name,
            currentVersion,
            owner,
            options.getPriorFiles,
          );
          const incomingSnapshot: VersionSnapshot = {
            version: manifest.version,
            contentHash,
            files: fileDigestsAsRecord(fileDigests),
            manifest,
          };
          versionDiff = computeVersionDiff(priorSnapshot, incomingSnapshot);
          approvalPath = selectApprovalPath(versionDiff);
        }
      }

      const id = generateId();
      const createdAt = now().toISOString();
      const status: SubmissionStatus = { phase: 'uploaded' };

      const statusJsonPayload =
        approvalPath !== undefined ? { ...status, approvalPath } : status;

      const insertRow: SubmissionInsertRow = {
        id,
        manifestJson: JSON.stringify(manifest),
        classification,
        contentHash,
        submittedAt: createdAt,
        submittedBy,
        statusPhase: status.phase,
        statusJson: JSON.stringify(statusJsonPayload),
      };

      if (db) {
        try {
          db.transaction(() => {
            insertSubmission(db, insertRow);
            if (versionDiff !== undefined) {
              insertVersionDiff(db, id, versionDiff);
            }
            if (!acquirePendingVersion(db, manifest.name, manifest.version, id)) {
              throw new PendingVersionContentionError();
            }
          })();
        } catch (error) {
          if (error instanceof PendingVersionContentionError) {
            return apiError(c, 409, 'version_in_progress', {
              details: { name: manifest.name, version: manifest.version },
            });
          }
          throw error;
        }
      } else if (persist) {
        await persist(insertRow);
      }

      const submission: Submission = {
        id,
        manifest,
        classification,
        contentHash,
        submittedAt: createdAt,
        submittedBy,
        status,
      };

      if (db) {
        const initialRow = getSubmissionById(db, id);
        const submissionLockVersion = initialRow?.lock_version ?? 0;
        const workflowDependencies =
          options.workflowDependencies ?? defaultWorkflowDependencies(options);
        await workflowDependencies.audit('submission.created', {
          actor: submittedBy,
          submissionId: id,
          skillName: manifest.name,
          version: manifest.version,
        });

        try {
          const result = await runApprovalPipeline(
            {
              submissionId: id,
              submission,
              manifest,
              files: await buildWorkflowFiles(files, extractedDir),
              contentHash,
              extractedDir,
              zipBufferBase64: (await readFile(zipPath)).toString('base64'),
              classification,
              ...(versionDiff !== undefined ? { versionDiff } : {}),
            },
            workflowDependencies,
          );
          if (result.status === 'failed') {
            throw new Error(result.errors?.[0]?.message ?? 'approval pipeline failed');
          }
          const workflowStatus = statusFromWorkflowResult(id, result.context, now);
          const context = {
            ...result.context,
            status: workflowStatus.phase,
            submission: {
              ...result.context.submission,
              status: workflowStatus,
            },
          };
          saveWorkflowRun(db, {
            id,
            submittedBy,
            serializedContext: result.serializedContext,
            context,
          }, now());
          const statusUpdate = {
            statusPhase: workflowStatus.phase,
            statusJson: JSON.stringify(statusJsonWithApprovalPath(workflowStatus, approvalPath)),
          };
          const owner = ownerFromPrincipal(submittedBy);
          const statusUpdated = workflowStatus.phase === 'published'
            ? publishSubmissionVersion(db, {
              submissionId: id,
              expectedLockVersion: submissionLockVersion,
              status: statusUpdate,
              owner,
              skillName: manifest.name,
              version: manifest.version,
              skillVersion: {
                owner,
                skill_name: manifest.name,
                version: manifest.version,
                content_hash: contentHash,
                submission_id: id,
                published_at: workflowStatus.publishedAt,
                published_by: submittedBy,
                approved_by: null,
                pr_number: result.context.prNumber ?? 0,
                merge_commit: workflowStatus.mergeCommit,
                scan_report_id: null,
                yanked_at: null,
                yanked_by: null,
                yank_reason: null,
              },
            })
            : updateSubmissionStatus(db, id, submissionLockVersion, statusUpdate);
          if (!statusUpdated) {
            throw new LockVersionMismatchError(id, submissionLockVersion);
          }
          submission.status = workflowStatus;
          if (workflowStatus.phase === 'published' && options.triggerMarketplaceSync) {
            await options.triggerMarketplaceSync(manifest.name);
          }
          releasePendingVersionIfTerminal(db, manifest, workflowStatus);
        } catch (error) {
          releasePendingVersion(db, manifest.name, manifest.version);
          if (error instanceof LockVersionMismatchError) {
            return apiError(c, 409, 'submission_in_progress', {
              message: error.message,
            });
          }
          return apiError(c, 500, 'internal_error', {
            message: error instanceof Error ? error.message : 'approval pipeline failed',
          });
        }
      }

      const responseStatus =
        statusJsonWithApprovalPath(submission.status, approvalPath);

      return c.json(
        {
          id: submission.id,
          status: responseStatus,
          manifest: submission.manifest,
          contentHash: submission.contentHash,
          createdAt,
        },
        201,
      );
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  return routes;
}

function isTerminalSubmissionStatus(status: SubmissionStatus): boolean {
  return status.phase === 'published' || status.phase === 'rejected' || status.phase === 'withdrawn';
}

function statusJsonWithApprovalPath(
  status: SubmissionStatus,
  approvalPath: ApprovalPath | undefined,
): SubmissionStatus & { approvalPath?: ApprovalPath } {
  return approvalPath !== undefined ? { ...status, approvalPath } : status;
}

async function writeUploadedFile(file: UploadedFile, destination: string): Promise<void> {
  if (file.stream) {
    await pipeline(Readable.fromWeb(file.stream()), createWriteStream(destination));
    return;
  }

  await writeFile(destination, Buffer.from(await file.arrayBuffer()));
}

async function hashExtractedFiles(files: string[], extractedDir: string): Promise<FileDigestEntry[]> {
  const entries: FileDigestEntry[] = [];
  for (const relPath of files) {
    const absolutePath = join(extractedDir, relPath);
    const fileStat = await stat(absolutePath);
    const hash = createHash('sha256');
    await pipeline(createReadStream(absolutePath), hash);
    entries.push({
      path: relPath,
      size: fileStat.size,
      sha256: hash.digest(),
    });
  }
  return entries;
}

async function buildWorkflowFiles(
  files: string[],
  extractedDir: string,
): Promise<Array<{ path: string; contentBase64: string }>> {
  const entries: Array<{ path: string; contentBase64: string }> = [];
  for (const relPath of files) {
    entries.push({
      path: relPath,
      contentBase64: (await readFile(join(extractedDir, relPath))).toString('base64'),
    });
  }
  return entries;
}

function fileDigestsAsRecord(entries: FileDigestEntry[]): Record<string, string> {
  const record: Record<string, string> = {};
  for (const entry of entries) {
    record[entry.path] = entry.sha256.toString('hex');
  }
  return record;
}

function buffersAsDigestRecord(
  entries: Array<{ path: string; content: Buffer }>,
): Record<string, string> {
  const record: Record<string, string> = {};
  for (const entry of entries) {
    record[entry.path] = createHash('sha256').update(entry.content).digest('hex');
  }
  return record;
}

async function buildPriorSnapshot(
  db: Database.Database,
  skillName: string,
  currentVersion: string,
  owner: string,
  getPriorFiles: GetPriorFiles | undefined,
): Promise<VersionSnapshot | null> {
  const versionRow = getSkillVersion(db, skillName, currentVersion, owner);
  if (versionRow === undefined) {
    return null;
  }

  const submissionRow = getSubmissionById(db, versionRow.submission_id);
  if (submissionRow === undefined) {
    return null;
  }

  let priorManifest: SkillManifest;
  try {
    priorManifest = JSON.parse(submissionRow.manifest_json) as SkillManifest;
  } catch {
    return null;
  }

  const priorFiles = getPriorFiles ? await getPriorFiles(skillName, currentVersion, owner) : null;

  return {
    version: versionRow.version,
    contentHash: versionRow.content_hash,
    files: priorFiles ? buffersAsDigestRecord(priorFiles) : {},
    manifest: priorManifest,
  };
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

function releasePendingVersionIfTerminal(
  db: Database.Database,
  manifest: SkillManifest,
  status: SubmissionStatus,
): void {
  if (status.phase === 'published' || status.phase === 'rejected') {
    releasePendingVersion(db, manifest.name, manifest.version);
  }
}

function defaultWorkflowDependencies(options: SubmissionRouteOptions): ApprovalPipelineDependencies {
  return {
    svc(token) {
      if (token !== ForgejoClient) {
        throw new Error('unexpected service token');
      }
      return (options.forgejo ?? forgejoFromEnv()) as never;
    },
    audit() {},
  };
}

function canViewSubmission(submission: Submission, identity: Identity): boolean {
  return (
    submission.submittedBy === identity.sub ||
    identity.roles.includes('Compliance') ||
    identity.roles.includes('Admin')
  );
}

export const submissionRoutes = createSubmissionRoutes();

function isMultipartContentType(value: string | undefined): boolean {
  return typeof value === 'string' && value.toLowerCase().includes('multipart/form-data');
}

function isUploadedFile(value: unknown): value is UploadedFile {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const candidate = value as Partial<UploadedFile>;
  return typeof candidate.arrayBuffer === 'function' && typeof candidate.size === 'number';
}
