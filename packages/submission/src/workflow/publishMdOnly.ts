import type { ForgejoClient, Submission } from '@asr/core';
import type { Database } from '../db/index.js';
import { updateSubmissionStatus } from '../db/repositories/submissions.js';
import { packSkillZip } from '../zip/pack.js';

export interface PublishMdOnlyDeps {
  db: Database;
  forgejo: ForgejoClient;
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

  const { branch, prNumber } = await forgejo.openSubmissionPR({
    submissionId: submission.id,
    manifest,
    files,
    autoApprove: true,
  });

  const { sha } = await forgejo.mergePR(prNumber);

  const zipBuffer = await packSkillZip(files);
  const packageUrl = await forgejo.publishArtifact({
    owner: manifest.author,
    name: manifest.name,
    version: manifest.version,
    zipBuffer,
  });

  await forgejo.deleteBranch(branch);

  updateSubmissionStatus(db, submission.id, lockVersion, {
    statusPhase: 'published',
    statusJson: JSON.stringify({
      phase: 'published',
      publishedAt: new Date().toISOString(),
      mergeCommit: sha,
    }),
  });

  return { mergeCommit: sha, packageUrl };
}
