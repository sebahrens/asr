import type { ForgejoClient, Submission } from '@asr/core';
import type { Database } from '../db/index.js';
import { getSkillVersion, insertSkillVersion } from '../db/repositories/skillVersions.js';
import { ownerFromPrincipal } from '../identity/owners.js';
import { updateSubmissionStatus } from '../db/repositories/submissions.js';
import { packSkillZip } from '../zip/pack.js';
import { LockVersionMismatchError } from './errors.js';
import { buildPublishRecord, serializePublishRecord } from './publishRecord.js';

export { LockVersionMismatchError } from './errors.js';

export interface PublishMdOnlyDeps {
  db: Database;
  forgejo: ForgejoClient;
  triggerMarketplaceSync?: (skillName: string) => Promise<void>;
}

export interface PublishMdOnlyInput {
  submission: Submission;
  files: Array<{ path: string; content: Buffer }>;
  lockVersion: number;
}

export interface PublishMdOnlyResult {
  mergeCommit: string;
  packageUrl: string;
}

export async function publishMdOnly(
  deps: PublishMdOnlyDeps,
  input: PublishMdOnlyInput,
): Promise<PublishMdOnlyResult> {
  const { db, forgejo } = deps;
  const { submission, files, lockVersion } = input;
  const { manifest } = submission;
  const owner = ownerFromPrincipal(submission.submittedBy);

  const publishedAt = new Date().toISOString();
  const publishRecord = buildPublishRecord({
    contentHash: submission.contentHash,
    scanReportId: null,
    approver: 'system',
    runId: submission.id,
    publishedAt,
  });
  const filesWithRecord = [
    ...files,
    { path: '.publish-record.json', content: serializePublishRecord(publishRecord) },
  ];

  const { branch, prNumber } = await forgejo.openSubmissionPR({
    submissionId: submission.id,
    manifest,
    files: filesWithRecord,
    autoApprove: true,
  });

  const { sha } = await forgejo.mergePR(prNumber);

  const zipBuffer = await packSkillZip(files);
  const packageUrl = await forgejo.publishArtifact({
    owner,
    name: manifest.name,
    version: manifest.version,
    zipBuffer,
  });

  await forgejo.deleteBranch(branch);

  if (!getSkillVersion(db, manifest.name, manifest.version, owner)) {
    insertSkillVersion(db, {
      owner,
      skill_name: manifest.name,
      version: manifest.version,
      content_hash: submission.contentHash,
      submission_id: submission.id,
      published_at: publishedAt,
      published_by: submission.submittedBy,
      approved_by: null,
      pr_number: prNumber,
      merge_commit: sha,
      scan_report_id: null,
      yanked_at: null,
      yanked_by: null,
      yank_reason: null,
    });
  }

  const updated = updateSubmissionStatus(db, submission.id, lockVersion, {
    statusPhase: 'published',
    statusJson: JSON.stringify({
      phase: 'published',
      publishedAt,
      mergeCommit: sha,
    }),
  });
  if (!updated) {
    throw new LockVersionMismatchError(submission.id, lockVersion);
  }

  if (deps.triggerMarketplaceSync) {
    try {
      await deps.triggerMarketplaceSync(manifest.name);
    } catch {
      // runMarketplaceSync already emits marketplace_sync.failed and pages;
      // a sync failure must not roll back the publish (specs/cli-integration.md#sync-job).
    }
  }

  return { mergeCommit: sha, packageUrl };
}
