import {
  canonicalHash,
  parseSkillManifest,
  type ForgejoClient,
  type Submission,
  type SubmissionStatus,
} from '@asr/core';
import type Database from 'better-sqlite3';
import { Hono } from 'hono';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ulid } from 'ulid';
import type { AuthVariables } from '../auth/types.js';
import {
  getSubmissionById,
  insertSubmission,
  rowToSubmission,
  type SubmissionInsertRow,
} from '../db/repositories/submissions.js';
import { findSubmissionIdByContentHash, getBlockedHash } from '../db/repositories/versions.js';
import { forgejoFromEnv } from '../forgejo/index.js';
import {
  acquirePendingVersion,
  releasePendingVersion,
} from '../workflow/pendingVersionLock.js';
import { publishMdOnly } from '../workflow/publishMdOnly.js';
import { classifySkill } from '../zip/classify.js';
import { extractSafe } from '../zip/extract.js';
import { apiError } from './errors.js';

export type SubmissionPersist = (row: SubmissionInsertRow) => void | Promise<void>;
export type SubmissionLookup = (
  id: string,
) => Submission | undefined | Promise<Submission | undefined>;

export interface SubmissionRouteOptions {
  db?: Database.Database;
  persist?: SubmissionPersist;
  lookup?: SubmissionLookup;
  now?: () => Date;
  generateId?: () => string;
  forgejo?: ForgejoClient;
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

  routes.post('/', async (c, next) => {
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
      }

      const id = generateId();
      const createdAt = now().toISOString();
      const status: SubmissionStatus = { phase: 'uploaded' };
      const submittedBy = c.get('identity')?.sub ?? process.env.MOCK_USER_SUB ?? '';

      const insertRow: SubmissionInsertRow = {
        id,
        manifestJson: JSON.stringify(manifest),
        classification,
        contentHash,
        submittedAt: createdAt,
        submittedBy,
        statusPhase: status.phase,
        statusJson: JSON.stringify(status),
      };

      if (db) {
        try {
          db.transaction(() => {
            insertSubmission(db, insertRow);
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

      if (classification === 'md-only' && db) {
        try {
          const forgejo = options.forgejo ?? forgejoFromEnv();
          const result = await publishMdOnly(
            { db, forgejo },
            { submission, files: fileEntries, lockVersion: 0 },
          );
          submission.status = {
            phase: 'published',
            publishedAt: now().toISOString(),
            mergeCommit: result.mergeCommit,
          };
        } catch (error) {
          releasePendingVersion(db, manifest.name, manifest.version);
          return apiError(c, 500, 'internal_error', {
            message: error instanceof Error ? error.message : 'md-only publish failed',
          });
        }
      }

      return c.json(
        {
          id: submission.id,
          status: submission.status,
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

