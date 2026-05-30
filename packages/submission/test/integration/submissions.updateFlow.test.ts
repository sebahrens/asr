import type { SkillManifest } from '@asr/core';
import Database from 'better-sqlite3';
import { Hono } from 'hono';
import { afterEach, describe, expect, it } from 'vitest';
import yazl from 'yazl';
import type { AuthVariables } from '../../src/auth/types.js';
import { runMigrations } from '../../src/db/migrations/index.js';
import { createSubmissionRoutes, type GetPriorFiles } from '../../src/http/submissions.js';

const SKILL_NAME = 'x';
const PRIOR_VERSION = '1.0.0';

describe('POST /api/v1/submissions update flow', () => {
  let db: Database.Database | undefined;

  afterEach(() => {
    db?.close();
    db = undefined;
  });

  it('persists a low-risk diff and auto-approve path when only SKILL.md is edited', async () => {
    db = new Database(':memory:');
    runMigrations(db);

    const priorSkillMd = skillMdFixture({
      name: SKILL_NAME,
      version: PRIOR_VERSION,
      author: 'alice',
      description: 'Initial release of x',
    });
    seedPriorVersion(db, {
      skillName: SKILL_NAME,
      version: PRIOR_VERSION,
      manifest: parseManifestFromMd(priorSkillMd),
      files: [{ path: 'SKILL.md', content: Buffer.from(priorSkillMd) }],
    });

    const getPriorFiles: GetPriorFiles = async () => [
      { path: 'SKILL.md', content: Buffer.from(priorSkillMd) },
    ];

    const newSkillMd = skillMdFixture({
      name: SKILL_NAME,
      version: '1.1.0',
      author: 'alice',
      description: 'Edited description for x',
    });

    const app = makeApp(db, getPriorFiles);
    const res = await app.request('/api/v1/submissions', {
      method: 'POST',
      body: await buildFormData([{ path: 'SKILL.md', contents: newSkillMd }]),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      id: string;
      status: { phase: string; approvalPath?: string };
    };
    expect(body.status.approvalPath).toBe('auto-approve');

    const diffRow = db
      .prepare('SELECT risk, diff_json FROM version_diffs WHERE submission_id = ?')
      .get(body.id) as { risk: string; diff_json: string } | undefined;
    expect(diffRow).toBeDefined();
    expect(diffRow?.risk).toBe('low');
    const diff = JSON.parse(diffRow!.diff_json) as { filesModified: string[]; filesAdded: string[] };
    expect(diff.filesModified).toContain('SKILL.md');
    expect(diff.filesAdded).toEqual([]);

    const submissionRow = db
      .prepare('SELECT status_json FROM submissions WHERE id = ?')
      .get(body.id) as { status_json: string } | undefined;
    expect(submissionRow).toBeDefined();
    const persistedStatus = JSON.parse(submissionRow!.status_json) as {
      phase: string;
      approvalPath: string;
    };
    expect(persistedStatus.approvalPath).toBe('auto-approve');
  });

  it('persists a higher-risk diff and full-review path when a code file is added', async () => {
    db = new Database(':memory:');
    runMigrations(db);

    const priorSkillMd = skillMdFixture({
      name: SKILL_NAME,
      version: PRIOR_VERSION,
      author: 'alice',
      description: 'Initial release of x',
    });
    seedPriorVersion(db, {
      skillName: SKILL_NAME,
      version: PRIOR_VERSION,
      manifest: parseManifestFromMd(priorSkillMd),
      files: [{ path: 'SKILL.md', content: Buffer.from(priorSkillMd) }],
    });

    const getPriorFiles: GetPriorFiles = async () => [
      { path: 'SKILL.md', content: Buffer.from(priorSkillMd) },
    ];

    const newSkillMd = skillMdFixture({
      name: SKILL_NAME,
      version: '1.1.0',
      author: 'alice',
      description: 'Adds a runner script',
    });
    const runPy = 'print("hello")\n';

    const app = makeApp(db, getPriorFiles);
    const res = await app.request('/api/v1/submissions', {
      method: 'POST',
      body: await buildFormData([
        { path: 'SKILL.md', contents: newSkillMd },
        { path: 'run.py', contents: runPy },
      ]),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      id: string;
      status: { phase: string; approvalPath?: string };
    };
    expect(body.status.approvalPath).toBe('full-review');

    const diffRow = db
      .prepare('SELECT risk, diff_json FROM version_diffs WHERE submission_id = ?')
      .get(body.id) as { risk: string; diff_json: string } | undefined;
    expect(diffRow).toBeDefined();
    expect(['medium', 'high']).toContain(diffRow?.risk);
    const diff = JSON.parse(diffRow!.diff_json) as { filesAdded: string[] };
    expect(diff.filesAdded).toContain('run.py');

    const submissionRow = db
      .prepare('SELECT status_phase, status_json FROM submissions WHERE id = ?')
      .get(body.id) as { status_phase: string; status_json: string } | undefined;
    expect(submissionRow?.status_phase).toBe('questionnaire-pending');
    const persistedStatus = JSON.parse(submissionRow!.status_json) as {
      approvalPath: string;
    };
    expect(persistedStatus.approvalPath).toBe('full-review');
  });

  it('returns 409 version_not_greater when the submitted version is lower than the current published version', async () => {
    db = new Database(':memory:');
    runMigrations(db);

    const priorSkillMd = skillMdFixture({
      name: SKILL_NAME,
      version: PRIOR_VERSION,
      author: 'alice',
      description: 'Initial release of x',
    });
    seedPriorVersion(db, {
      skillName: SKILL_NAME,
      version: PRIOR_VERSION,
      manifest: parseManifestFromMd(priorSkillMd),
      files: [{ path: 'SKILL.md', content: Buffer.from(priorSkillMd) }],
    });

    const downgradedSkillMd = skillMdFixture({
      name: SKILL_NAME,
      version: '0.9.0',
      author: 'alice',
      description: 'Attempted downgrade',
    });

    const app = makeApp(db);
    const res = await app.request('/api/v1/submissions', {
      method: 'POST',
      body: await buildFormData([{ path: 'SKILL.md', contents: downgradedSkillMd }]),
    });

    expect(res.status).toBe(409);
    const body = (await res.json()) as {
      error: string;
      details?: { name?: string; next?: string; current?: string };
    };
    expect(body.error).toBe('version_not_greater');
    expect(body.details?.name).toBe(SKILL_NAME);
    expect(body.details?.next).toBe('0.9.0');
    expect(body.details?.current).toBe(PRIOR_VERSION);

    const newSubmissionCount = db
      .prepare("SELECT COUNT(*) AS c FROM submissions WHERE id != 'prior-submission-1'")
      .get() as { c: number };
    expect(newSubmissionCount.c).toBe(0);

    const diffCount = db.prepare('SELECT COUNT(*) AS c FROM version_diffs').get() as {
      c: number;
    };
    expect(diffCount.c).toBe(0);
  });
});

function makeApp(db: Database.Database, getPriorFiles?: GetPriorFiles) {
  const app = new Hono<{ Variables: AuthVariables }>();
  app.use('*', async (c, next) => {
    c.set('identity', { sub: 'alice', roles: ['Submitter'] });
    await next();
  });
  app.route(
    '/api/v1/submissions',
    createSubmissionRoutes({
      db,
      forgejo: makeFakeForgejo() as never,
      ...(getPriorFiles ? { getPriorFiles } : {}),
    }),
  );
  return app;
}

function makeFakeForgejo() {
  return {
    async openSubmissionPR() {
      return { branch: 'submit/x', prNumber: 2, headSha: 'head-sha' };
    },
    async mergePR() {
      return { sha: 'merge-sha' };
    },
    async publishArtifact() {
      return 'https://forgejo.example/package/url';
    },
    async deleteBranch() {
      // no-op
    },
  };
}

interface SeedInput {
  skillName: string;
  version: string;
  manifest: SkillManifest;
  files: Array<{ path: string; content: Buffer }>;
}

function seedPriorVersion(db: Database.Database, input: SeedInput): void {
  const submissionId = 'prior-submission-1';
  const contentHash = `sha256:prior-${input.skillName}-${input.version}`;

  db.prepare(
    `
      INSERT INTO submissions (
        id, manifest_json, classification, content_hash,
        submitted_at, submitted_by, status_phase, status_json
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `,
  ).run(
    submissionId,
    JSON.stringify(input.manifest),
    'md-only',
    contentHash,
    '2026-05-20T00:00:00.000Z',
    'alice',
    'published',
    JSON.stringify({
      phase: 'published',
      publishedAt: '2026-05-20T00:00:00.000Z',
      mergeCommit: 'prior-merge-sha',
    }),
  );

  db.prepare(
    `
      INSERT INTO skill_versions (
        owner, skill_name, version, content_hash, submission_id,
        published_at, published_by, approved_by, pr_number, merge_commit,
        scan_report_id, risk_assessment, yanked_at, yanked_by, yank_reason
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
  ).run(
    'alice',
    input.skillName,
    input.version,
    contentHash,
    submissionId,
    '2026-05-20T00:00:00.000Z',
    'alice',
    null,
    1,
    'prior-merge-sha',
    null,
    'low',
    null,
    null,
    null,
  );

  // input.files is reserved for future use (e.g., a real file-store seeding helper).
  void input.files;
}

function skillMdFixture(input: {
  name: string;
  version: string;
  author: string;
  description?: string;
}): string {
  return `---
name: ${input.name}
version: ${input.version}
author: ${input.author}
description: ${input.description ?? 'Update flow test fixture'}
tags:
  - demo
kind: skill
permissions:
  network: false
  filesystem: none
  subprocess: false
  environment: []
---

# ${input.name}

Body.
`;
}

function parseManifestFromMd(md: string): SkillManifest {
  const match = md.match(/---\n([\s\S]*?)\n---/);
  if (!match) {
    throw new Error('SKILL.md fixture has no frontmatter');
  }
  // The fixtures are simple enough that we can hardcode the manifest the same way the
  // server would parse them via gray-matter; keep this in sync with skillMdFixture above.
  const lines = match[1].split('\n');
  const get = (key: string): string =>
    lines.find((l) => l.startsWith(`${key}:`))?.split(':').slice(1).join(':').trim() ?? '';
  return {
    name: get('name'),
    version: get('version'),
    author: get('author'),
    description: get('description'),
    tags: ['demo'],
    kind: 'skill',
    permissions: {
      network: false,
      filesystem: 'none',
      subprocess: false,
      environment: [],
    },
  };
}

async function buildFormData(
  entries: Array<{ path: string; contents: string }>,
): Promise<FormData> {
  const zip = new yazl.ZipFile();
  for (const entry of entries) {
    zip.addBuffer(Buffer.from(entry.contents), entry.path);
  }
  zip.end();
  const zipBytes = await streamToBuffer(zip.outputStream);
  const formData = new FormData();
  formData.set(
    'file',
    new Blob([new Uint8Array(zipBytes)], { type: 'application/zip' }),
    'skill.zip',
  );
  return formData;
}

async function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as unknown as Uint8Array));
  }
  return Buffer.concat(chunks);
}
