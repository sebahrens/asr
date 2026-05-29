import type { SkillDetail, SkillKind, SkillVersion, VersionDiff } from '@asr/core';
import BetterSqlite3 from 'better-sqlite3';
import type Database from 'better-sqlite3';
import { Hono } from 'hono';
import { runMigrations } from '../db/migrations/index.js';
import { getPublishedSkill, getPublishedSkillVersion, listPublishedSkills } from '../db/repositories/skills.js';
import {
  listVersions,
  resolveLatestVersion,
  type SkillVersionRow,
} from '../db/repositories/skillVersions.js';
import { insertSubmission } from '../db/repositories/submissions.js';
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

export interface RegistryRouteOptions {
  db?: Database.Database;
  forgejoUrl?: string;
}

const defaultRegistryDb = createDefaultRegistryDb();

export function getDefaultRegistryDb(): Database.Database {
  return defaultRegistryDb;
}

export function createRegistryRoutes(options: RegistryRouteOptions = {}) {
  const routes = new Hono();
  const db = options.db ?? defaultRegistryDb;
  const forgejoUrl = options.forgejoUrl ?? process.env.FORGEJO_URL ?? 'http://forgejo:3000';

  routes.get('/', (c) => {
    const limit = parseLimit(c.req.query('limit'));
    const offset = decodeCursor(c.req.query('cursor'));
    const result = listPublishedSkills(db, {
      q: c.req.query('q'),
      tag: c.req.query('tag'),
      kind: parseKind(c.req.query('kind')),
      limit,
      offset,
    });

    c.header('Cache-Control', 'public, max-age=60');
    return c.json({
      items: result.items,
      nextCursor: result.nextOffset === null ? null : encodeCursor(result.nextOffset),
    });
  });

  routes.get('/:owner/:name', (c) => {
    const owner = c.req.param('owner');
    const name = c.req.param('name');
    const skill = getPublishedSkill(db, owner, name);
    if (!skill) {
      return apiError(c, 404, 'submission_not_found');
    }

    const versionRows = listVersions(db, name);
    c.header('Cache-Control', 'public, max-age=60');
    if (versionRows.length === 0) {
      return c.json(skill);
    }

    return c.json({
      ...skill,
      latestVersion: resolveLatestVersion(db, name) ?? null,
      versions: versionRows.map((row) => mapSkillVersionRow(row, owner)),
    });
  });

  routes.get('/:owner/:name/v/:version', (c) => {
    const resolved = getPublishedSkillVersion(
      db,
      c.req.param('owner'),
      c.req.param('name'),
      c.req.param('version'),
    );
    if (!resolved) {
      return apiError(c, 404, 'submission_not_found');
    }

    c.header('Cache-Control', 'public, max-age=60');
    return c.json({
      manifest: resolved.manifest,
      skillMd: resolved.skillMd,
      version: resolved.skillVersion,
    });
  });

  routes.get('/:owner/:name/v/:version/download', (c) => {
    const owner = c.req.param('owner');
    const name = c.req.param('name');
    const version = c.req.param('version');
    const skill = getPublishedSkill(db, owner, name);
    const publishedVersion = skill?.versions.find((candidate) => candidate.version === version);
    if (!publishedVersion) {
      return apiError(c, 404, 'submission_not_found');
    }

    if (publishedVersion.yanked) {
      c.header('X-ASR-Yanked', 'true');
    }

    return c.redirect(forgejoPackageUrl(forgejoUrl, owner, name, version), 302);
  });

  routes.get('/:owner/:name/versions', (c) => {
    const skill = getPublishedSkill(db, c.req.param('owner'), c.req.param('name'));
    if (!skill) {
      return apiError(c, 404, 'submission_not_found');
    }

    c.header('Cache-Control', 'public, max-age=60');
    return c.json(skill.versions.filter((version) => !version.yanked));
  });

  routes.get('/:owner/:name/versions/:version/diff', (c) => {
    const skill = getPublishedSkill(db, c.req.param('owner'), c.req.param('name'));
    if (!skill || !skill.versions.some((version) => version.version === c.req.param('version'))) {
      return apiError(c, 404, 'skill_not_found');
    }

    const diff = registryDiffs.find((candidate) =>
      candidate.skillName === skill.name && candidate.toVersion === c.req.param('version'),
    );
    if (!diff) {
      return apiError(c, 404, 'version_diff_not_found');
    }

    c.header('Cache-Control', 'public, max-age=60');
    return c.json(diff);
  });

  return routes;
}

export const registryRoutes = createRegistryRoutes();

function parseLimit(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  const limit = Number(value);
  return Number.isFinite(limit) ? Math.min(Math.trunc(limit), 100) : undefined;
}

function parseKind(value: string | undefined): SkillKind | undefined {
  return value === 'skill' || value === 'persona' ? value : undefined;
}

function decodeCursor(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }

  try {
    const decoded = JSON.parse(Buffer.from(value, 'base64').toString('utf8')) as { offset?: unknown };
    return typeof decoded.offset === 'number' ? decoded.offset : undefined;
  } catch {
    return undefined;
  }
}

function encodeCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ offset }), 'utf8').toString('base64');
}

function mapSkillVersionRow(row: SkillVersionRow, owner: string): SkillVersion {
  return {
    owner,
    name: row.skill_name,
    version: row.version,
    contentHash: row.content_hash,
    publishedAt: row.published_at,
    publishedBy: row.published_by,
    approvedBy: row.approved_by,
    prNumber: row.pr_number,
    mergeCommit: row.merge_commit,
    yanked: row.yanked_at !== null,
    ...(row.yanked_at ? { yankedAt: row.yanked_at } : {}),
    ...(row.yank_reason ? { yankReason: row.yank_reason } : {}),
    riskAssessment: 'low',
  };
}

function forgejoPackageUrl(forgejoUrl: string, owner: string, name: string, version: string): string {
  const base = forgejoUrl.replace(/\/api\/v1\/?$/, '').replace(/\/$/, '');
  return `${base}/api/packages/${owner}/generic/${name}/${version}/skill.zip`;
}

function createDefaultRegistryDb(): Database.Database {
  const db = new BetterSqlite3(':memory:');
  runMigrations(db);

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
          riskAssessment: version.riskAssessment,
          skillMd: version.version === skill.latestVersion ? skill.skillMd : undefined,
        }),
      });
    }
  }

  return db;
}
