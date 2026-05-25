import type { SkillDetail, SkillSummary, VersionDiff } from '@asr/core';
import { Hono } from 'hono';
import { apiError } from './errors.js';

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

export const registryRoutes = new Hono();

registryRoutes.get('/', (c) => {
  const query = c.req.query('q')?.trim().toLowerCase();
  const tags = c.req.queries('tag') ?? [];
  const items = registrySkills
    .filter((skill) => matchesQuery(skill, query))
    .filter((skill) => tags.every((tag) => skill.tags.includes(tag)))
    .map(toSummary);

  return c.json({ items });
});

registryRoutes.get('/:owner/:name', (c) => {
  const skill = findSkill(c.req.param('owner'), c.req.param('name'));
  if (!skill) {
    return apiError(c, 404, 'skill_not_found');
  }

  return c.json(skill);
});

registryRoutes.get('/:owner/:name/versions/:version/diff', (c) => {
  const skill = findSkill(c.req.param('owner'), c.req.param('name'));
  if (!skill || !skill.versions.some((version) => version.version === c.req.param('version'))) {
    return apiError(c, 404, 'skill_not_found');
  }

  const diff = registryDiffs.find((candidate) =>
    candidate.skillName === skill.name && candidate.toVersion === c.req.param('version'),
  );
  if (!diff) {
    return apiError(c, 404, 'version_diff_not_found');
  }

  return c.json(diff);
});

function matchesQuery(skill: SkillDetail, query: string | undefined): boolean {
  if (!query) {
    return true;
  }

  return [
    skill.owner,
    skill.name,
    skill.description,
    ...skill.tags,
  ].some((value) => value.toLowerCase().includes(query));
}

function findSkill(owner: string, name: string): SkillDetail | undefined {
  return registrySkills.find((skill) => skill.owner === owner && skill.name === name);
}

function toSummary(skill: SkillDetail): SkillSummary {
  return {
    owner: skill.owner,
    name: skill.name,
    latestVersion: skill.latestVersion,
    description: skill.description,
    tags: skill.tags,
    kind: skill.kind,
    publishedAt: skill.publishedAt,
    downloadCount: skill.downloadCount,
    riskAssessmentLatest: skill.riskAssessmentLatest,
  };
}
