import {
  canonicalHash,
  computeVersionDiff,
  parseSkillManifest,
  selectApprovalPath,
  validateVersionUpgrade,
  ForgejoClient,
  type ApprovalPath,
  type SkillManifest,
  type Submission,
  type SubmissionStatus,
  type VersionSnapshot,
} from '@asr/core';
import type Database from 'better-sqlite3';
import { Hono } from 'hono';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ulid } from 'ulid';
import type { AuthVariables } from '../auth/types.js';
import {
  getSkillVersion,
  insertSkillVersion,
  resolveLatestVersion,
} from '../db/repositories/skillVersions.js';
import {
  getSubmissionById,
  insertSubmission,
  rowToSubmission,
  updateSubmissionStatus,
  type SubmissionInsertRow,
} from '../db/repositories/submissions.js';
import { insertVersionDiff } from '../db/repositories/versionDiffs.js';
import { findSubmissionIdByContentHash, getBlockedHash } from '../db/repositories/versions.js';
import { saveWorkflowRun } from '../db/repositories/workflowRuns.js';
import { forgejoFromEnv } from '../forgejo/index.js';
import { requireRole } from '../auth/requireRole.js';
import {
  acquirePendingVersion,
  releasePendingVersion,
} from '../workflow/pendingVersionLock.js';
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
) => Promise<Array<{ path: string; content: Buffer }> | null | undefined>;

export interface SubmissionRouteOptions {
  db?: Database.Database;
  persist?: SubmissionPersist;
  lookup?: SubmissionLookup;
  now?: () => Date;
  generateId?: () => string;
  forgejo?: ForgejoClient;
  getPriorFiles?: GetPriorFiles;
  triggerMarketplaceSync?: (skillName: string) => Promise<void>;
  workflowDependencies?: ApprovalPipelineDependencies;
}

interface UploadedFile {
  arrayBuffer(): Promise<ArrayBuffer>;
  size: number;
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

  routes.get('/:id', async (c) => {
    const id = c.req.param('id');
    const submission = lookup ? await lookup(id) : undefined;
    if (!submission) {
      return apiError(c, 404, 'submission_not_found');
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
      const zipBytes = Buffer.from(await file.arrayBuffer());
      await writeFile(zipPath, zipBytes);

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

      const fileEntries = await Promise.all(
        files.map(async (relPath) => ({
          path: relPath,
          content: await readFile(join(extractedDir, relPath)),
        })),
      );
      const contentHash = canonicalHash(fileEntries);

      const db = options.db;
      let currentVersion: string | undefined;
      let versionDiff: ReturnType<typeof computeVersionDiff> | undefined;
      let approvalPath: ApprovalPath | undefined;

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

        currentVersion = resolveLatestVersion(db, manifest.name);

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
            options.getPriorFiles,
          );
          const incomingSnapshot: VersionSnapshot = {
            version: manifest.version,
            contentHash,
            files: filesAsRecord(fileEntries),
            manifest,
          };
          versionDiff = computeVersionDiff(priorSnapshot, incomingSnapshot);
          approvalPath = selectApprovalPath(versionDiff);
        }
      }

      const id = generateId();
      const createdAt = now().toISOString();
      const status: SubmissionStatus = { phase: 'uploaded' };
      const identity = c.get('identity');
      if (!identity) {
        return apiError(c, 401, 'authentication_required');
      }
      const submittedBy = identity.sub;

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
        const workflowDependencies =
          options.workflowDependencies ?? defaultWorkflowDependencies(options, manifest.name);
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
              files: fileEntries.map((file) => ({
                path: file.path,
                contentBase64: file.content.toString('base64'),
              })),
              contentHash,
              extractedDir,
              zipBufferBase64: zipBytes.toString('base64'),
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
          if (workflowStatus.phase === 'published' && !getSkillVersion(db, manifest.name, manifest.version)) {
            insertSkillVersion(db, {
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
            });
          }
          updateSubmissionStatus(db, id, 0, {
            statusPhase: workflowStatus.phase,
            statusJson: JSON.stringify(statusJsonWithApprovalPath(workflowStatus, approvalPath)),
          });
          submission.status = workflowStatus;
        } catch (error) {
          releasePendingVersion(db, manifest.name, manifest.version);
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

function statusJsonWithApprovalPath(
  status: SubmissionStatus,
  approvalPath: ApprovalPath | undefined,
): SubmissionStatus & { approvalPath?: ApprovalPath } {
  return approvalPath !== undefined ? { ...status, approvalPath } : status;
}

function filesAsRecord(
  entries: Array<{ path: string; content: Buffer }>,
): Record<string, string> {
  const record: Record<string, string> = {};
  for (const entry of entries) {
    record[entry.path] = entry.content.toString('base64');
  }
  return record;
}

async function buildPriorSnapshot(
  db: Database.Database,
  skillName: string,
  currentVersion: string,
  getPriorFiles: GetPriorFiles | undefined,
): Promise<VersionSnapshot | null> {
  const versionRow = getSkillVersion(db, skillName, currentVersion);
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

  const priorFiles = getPriorFiles ? await getPriorFiles(skillName, currentVersion) : null;

  return {
    version: versionRow.version,
    contentHash: versionRow.content_hash,
    files: priorFiles ? filesAsRecord(priorFiles) : {},
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

function defaultWorkflowDependencies(
  options: SubmissionRouteOptions,
  skillName: string,
): ApprovalPipelineDependencies {
  return {
    svc(token) {
      if (token !== ForgejoClient) {
        throw new Error('unexpected service token');
      }
      return (options.forgejo ?? forgejoFromEnv()) as never;
    },
    audit() {},
    async regenerateRegistryIndex() {
      if (options.triggerMarketplaceSync) {
        await options.triggerMarketplaceSync(skillName);
      }
    },
  };
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
