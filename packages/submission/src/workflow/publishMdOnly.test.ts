import type { ForgejoClient, SkillManifest, Submission } from '@asr/core';
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../db/migrations/index.js';
import {
  getSubmissionById,
  insertSubmission,
  rowToSubmission,
} from '../db/repositories/submissions.js';
import { packSkillZip } from '../zip/pack.js';
import { publishMdOnly } from './publishMdOnly.js';

describe('publishMdOnly', () => {
  let db: Database.Database | undefined;

  afterEach(() => {
    db?.close();
    db = undefined;
  });

  it('opens a PR, merges, publishes artifact, deletes branch, and flips status to published', async () => {
    db = new Database(':memory:');
    runMigrations(db);

    const manifest: SkillManifest = {
      name: 'demo-skill',
      version: '1.0.0',
      author: 'alice',
      description: 'Demo md-only skill',
      tags: ['demo'],
      kind: 'skill',
      permissions: {
        network: false,
        filesystem: 'read-own',
        subprocess: false,
        environment: [],
      },
    };

    const files = [
      { path: 'SKILL.md', content: Buffer.from('# Demo\n') },
      { path: 'manifest.yaml', content: Buffer.from('name: demo-skill\n') },
    ];

    const expectedZip = await packSkillZip(files);
    const expectedZipSha = createHash('sha256').update(expectedZip).digest('hex');
    const expectedContentHash = `sha256:${expectedZipSha}`;

    const submission: Submission = {
      id: 'submission-md-only-1',
      manifest,
      classification: 'md-only',
      contentHash: expectedContentHash,
      submittedAt: '2026-05-26T00:00:00.000Z',
      submittedBy: 'alice',
      status: { phase: 'pushing-to-forgejo' },
    };

    insertSubmission(db, {
      id: submission.id,
      manifestJson: JSON.stringify(submission.manifest),
      classification: submission.classification,
      contentHash: submission.contentHash,
      submittedAt: submission.submittedAt,
      submittedBy: submission.submittedBy,
      statusPhase: submission.status.phase,
      statusJson: JSON.stringify(submission.status),
    });

    const packageUrlFromMock =
      'https://forgejo.example/api/packages/alice/generic/demo-skill/1.0.0/skill.zip';
    const forgejo = new FakeForgejoClient(packageUrlFromMock);

    const result = await publishMdOnly(
      { db, forgejo: forgejo as unknown as ForgejoClient },
      { submission, files, lockVersion: 0 },
    );

    expect(result).toEqual({ mergeCommit: 'abc', packageUrl: packageUrlFromMock });

    expect(forgejo.openCalls).toHaveLength(1);
    expect(forgejo.openCalls[0]).toMatchObject({
      submissionId: submission.id,
      autoApprove: true,
    });
    expect(forgejo.openCalls[0].files).toEqual(files);

    expect(forgejo.mergeCalls).toEqual([1]);
    expect(forgejo.publishCalls).toHaveLength(1);
    expect(forgejo.publishCalls[0]).toMatchObject({
      owner: 'alice',
      name: 'demo-skill',
      version: '1.0.0',
    });
    expect(forgejo.publishCalls[0].zipBuffer.length).toBeGreaterThan(0);
    const uploadedSha = createHash('sha256')
      .update(forgejo.publishCalls[0].zipBuffer)
      .digest('hex');
    expect(`sha256:${uploadedSha}`).toBe(submission.contentHash);
    expect(forgejo.deleteCalls).toEqual(['submit/x']);

    const row = getSubmissionById(db, submission.id);
    expect(row?.status_phase).toBe('published');
    expect(row?.lock_version).toBe(1);

    const hydrated = rowToSubmission(row!);
    expect(hydrated.status).toMatchObject({
      phase: 'published',
      mergeCommit: 'abc',
    });
  });
});

class FakeForgejoClient {
  openCalls: Array<{
    submissionId: string;
    manifest: SkillManifest;
    files: Array<{ path: string; content: Buffer }>;
    autoApprove: boolean;
  }> = [];
  mergeCalls: number[] = [];
  publishCalls: Array<{
    owner: string;
    name: string;
    version: string;
    zipBuffer: Buffer;
  }> = [];
  deleteCalls: string[] = [];

  constructor(private readonly packageUrl: string) {}

  async openSubmissionPR(input: {
    submissionId: string;
    manifest: SkillManifest;
    files: Array<{ path: string; content: Buffer }>;
    autoApprove: boolean;
  }) {
    this.openCalls.push(input);
    return { branch: 'submit/x', prNumber: 1, headSha: 'head-sha' };
  }

  async mergePR(prNumber: number) {
    this.mergeCalls.push(prNumber);
    return { sha: 'abc' };
  }

  async publishArtifact(input: {
    owner: string;
    name: string;
    version: string;
    zipBuffer: Buffer;
  }) {
    this.publishCalls.push(input);
    return this.packageUrl;
  }

  async deleteBranch(branch: string) {
    this.deleteCalls.push(branch);
  }
}
