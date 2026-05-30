import type { SkillDetail, VersionDiff } from '@asr/core';
import type Database from 'better-sqlite3';
import { insertSkillVersion } from '../db/repositories/skillVersions.js';
import { insertSubmission } from '../db/repositories/submissions.js';

const publishedAt = '2026-05-23T10:00:00.000Z';

const registrySkills: SkillDetail[] = [
  {
    owner: 'asr',
    name: 'security-review',
    latestVersion: '1.0.0',
    description: 'Reviews skill submissions for security risks and policy gaps.',
    tags: ['security', 'review', 'compliance'],
    kind: 'skill',
    publishedAt,
    downloadCount: 128,
    riskAssessmentLatest: 'low',
    manifestLatest: {
      name: 'security-review',
      version: '1.0.0',
      author: 'asr',
      description: 'Reviews skill submissions for security risks and policy gaps.',
      tags: ['security', 'review', 'compliance'],
      kind: 'skill',
      permissions: {
        network: false,
        filesystem: 'read-own',
        subprocess: false,
        environment: [],
      },
      compatibility: {
        codex: '>=0.1.0',
        'claude-code': '>=1.0.0',
      },
    },
    skillMd: `---
name: security-review
version: 1.0.0
author: asr
description: Reviews skill submissions for security risks and policy gaps.
tags:
  - security
  - review
  - compliance
kind: skill
permissions:
  network: false
  filesystem: read-own
  subprocess: false
  environment: []
---

# security-review

Use this skill to inspect submitted ASR skills before approval.

| Check | Evidence |
| --- | --- |
| Permissions | Compare manifest permissions with the submitted files. |
| Scanner output | Review every high and medium finding. |
| Separation of duties | Confirm the reviewer is not the submitter. |

\`\`\`text
approval = scanner_passed && reviewer_is_independent
\`\`\`

## Checklist

- Confirm the declared permissions match the implementation.
- Review scan findings and explain any accepted risk.
- Verify the approval decision respects separation of duties.
`,
    versions: [
      {
        owner: 'asr',
        name: 'security-review',
        version: '1.0.0',
        contentHash: 'sha256:dev-security-review-100',
        publishedAt,
        publishedBy: 'submitter-1',
        approvedBy: 'reviewer-1',
        prNumber: 42,
        mergeCommit: 'dev-merge-security-review-100',
        yanked: false,
        riskAssessment: 'low',
      },
    ],
  },
  {
    owner: 'asr',
    name: 'release-notes',
    latestVersion: '1.1.0',
    description: 'Drafts concise release notes from merged pull requests and changelogs.',
    tags: ['writing', 'release', 'markdown'],
    kind: 'skill',
    publishedAt: '2026-05-22T14:30:00.000Z',
    downloadCount: 86,
    riskAssessmentLatest: 'medium',
    manifestLatest: {
      name: 'release-notes',
      version: '1.1.0',
      author: 'asr',
      description: 'Drafts concise release notes from merged pull requests and changelogs.',
      tags: ['writing', 'release', 'markdown'],
      kind: 'skill',
      dependencies: {
        'markdown-it': '14.1.0',
      },
      permissions: {
        network: false,
        filesystem: 'read-own',
        subprocess: false,
        environment: [],
      },
    },
    skillMd: `# Release Notes

Draft concise release notes from merged pull requests.

| Section | Required |
| --- | --- |
| Features | Yes |
| Fixes | Yes |
| Migration notes | When applicable |
`,
    versions: [
      {
        owner: 'asr',
        name: 'release-notes',
        version: '1.1.0',
        contentHash: 'sha256:dev-release-notes-110',
        publishedAt: '2026-05-22T14:30:00.000Z',
        publishedBy: 'submitter-2',
        approvedBy: 'reviewer-1',
        prNumber: 41,
        mergeCommit: 'dev-merge-release-notes-110',
        yanked: false,
        riskAssessment: 'medium',
      },
      {
        owner: 'asr',
        name: 'release-notes',
        version: '1.0.0',
        contentHash: 'sha256:dev-release-notes-100',
        publishedAt: '2026-05-20T09:00:00.000Z',
        publishedBy: 'submitter-2',
        approvedBy: 'reviewer-1',
        prNumber: 39,
        mergeCommit: 'dev-merge-release-notes-100',
        yanked: false,
        riskAssessment: 'low',
      },
    ],
  },
];

const registryDiffs: VersionDiff[] = [
  {
    skillName: 'release-notes',
    fromVersion: '1.0.0',
    toVersion: '1.1.0',
    fromContentHash: 'sha256:dev-release-notes-100',
    toContentHash: 'sha256:dev-release-notes-110',
    filesAdded: ['templates/changelog.md'],
    filesRemoved: [],
    filesModified: ['SKILL.md'],
    dependenciesAdded: { 'markdown-it': '14.1.0' },
    dependenciesRemoved: {},
    dependenciesChanged: {},
    permissionsBefore: {
      network: false,
      filesystem: 'read-own',
      subprocess: false,
      environment: [],
    },
    permissionsAfter: {
      network: false,
      filesystem: 'read-own',
      subprocess: false,
      environment: [],
    },
    permissionsExpanded: false,
    manifestKindChanged: false,
    riskAssessment: 'medium',
    computedAt: '2026-05-22T14:31:00.000Z',
  },
  {
    skillName: 'security-review',
    fromVersion: '',
    toVersion: '1.0.0',
    fromContentHash: null,
    toContentHash: 'sha256:dev-security-review-100',
    filesAdded: ['SKILL.md'],
    filesRemoved: [],
    filesModified: [],
    dependenciesAdded: {},
    dependenciesRemoved: {},
    dependenciesChanged: {},
    permissionsBefore: null,
    permissionsAfter: {
      network: false,
      filesystem: 'read-own',
      subprocess: false,
      environment: [],
    },
    permissionsExpanded: false,
    manifestKindChanged: false,
    riskAssessment: 'low',
    computedAt: '2026-05-23T10:01:00.000Z',
  },
];

export function seedDevRegistryDb(db: Database.Database): void {
  const existing = db.prepare('SELECT COUNT(*) FROM skill_versions').pluck().get() as number;
  if (existing > 0) {
    return;
  }

  for (const skill of registrySkills) {
    for (const version of skill.versions) {
      insertSubmission(db, {
        id: `${skill.owner}-${skill.name}-${version.version}`,
        manifestJson: JSON.stringify(
          version.version === skill.latestVersion
            ? skill.manifestLatest
            : {
                ...skill.manifestLatest,
                version: version.version,
                description: skill.description,
              },
        ),
        classification: 'md-only',
        contentHash: version.contentHash,
        submittedAt: version.publishedAt,
        submittedBy: version.publishedBy,
        prNumber: version.prNumber,
        statusPhase: 'published',
        statusJson: JSON.stringify({
          phase: 'published',
          publishedAt: version.publishedAt,
          approvedBy: version.approvedBy,
          mergeCommit: version.mergeCommit,
          skillMd: version.version === skill.latestVersion ? skill.skillMd : undefined,
        }),
      });
      insertSkillVersion(db, {
        owner: skill.owner,
        skill_name: skill.name,
        version: version.version,
        content_hash: version.contentHash,
        submission_id: `${skill.owner}-${skill.name}-${version.version}`,
        published_at: version.publishedAt,
        published_by: version.publishedBy,
        approved_by: version.approvedBy,
        pr_number: version.prNumber,
        merge_commit: version.mergeCommit,
        scan_report_id: null,
        risk_assessment: version.riskAssessment,
        yanked_at: version.yanked ? version.publishedAt : null,
        yanked_by: version.yanked ? version.publishedBy : null,
        yank_reason: version.yankReason ?? null,
      });
    }
  }
}

export function findDevRegistryDiff(skillName: string, version: string): VersionDiff | undefined {
  return registryDiffs.find((candidate) =>
    candidate.skillName === skillName && candidate.toVersion === version,
  );
}
