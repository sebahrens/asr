import { ForgejoClient, type AuditAction, type ScanReport, type SkillManifest, type Submission } from '@asr/core';
import Database from 'better-sqlite3';
import { Hono } from 'hono';
import { afterEach, describe, expect, it } from 'vitest';
import yazl from 'yazl';
import type { AuthVariables, Identity } from '../auth/types.js';
import { runMigrations } from '../db/migrations/index.js';
import { getSkillVersion } from '../db/repositories/skillVersions.js';
import { updateSubmissionStatus } from '../db/repositories/submissions.js';
import { getWorkflowRun } from '../db/repositories/workflowRuns.js';
import type { ApprovalPipelineDependencies } from '../workflow/approvalPipeline.js';
import { createSubmissionRoutes } from './submissions.js';
import { createWorkflowRoutes } from './workflow.js';

describe('POST /api/v1/submissions (Flowcraft pipeline)', () => {
  let db: Database.Database | undefined;

  afterEach(() => {
    db?.close();
    db = undefined;
  });

  it('publishes an md-only submission through Flowcraft and exposes published status via GET', async () => {
    db = new Database(':memory:');
    runMigrations(db);

    const forgejo = new FakeForgejoClient();
    const app = new Hono<{ Variables: AuthVariables }>();
    app.use('*', async (c, next) => {
      c.set('identity', { sub: 'alice', roles: ['Submitter'] });
      await next();
    });
    app.route(
      '/api/v1/submissions',
      createSubmissionRoutes({ db, forgejo: forgejo as unknown as ForgejoClient }),
    );

    const zipBytes = await buildZip([
      {
        path: 'SKILL.md',
        contents: skillMdFixture({ name: 'demo-skill', version: '1.0.0', author: 'alice' }),
      },
      { path: 'README.md', contents: '# demo-skill\n' },
    ]);
    const formData = new FormData();
    formData.set(
      'file',
      new Blob([new Uint8Array(zipBytes)], { type: 'application/zip' }),
      'skill.zip',
    );

    const postRes = await app.request('/api/v1/submissions', {
      method: 'POST',
      body: formData,
    });
    expect(postRes.status).toBe(201);
    const created = (await postRes.json()) as {
      id: string;
      status: { phase: string; mergeCommit?: string };
    };
    expect(created.status.phase).toBe('published');
    expect(created.status.mergeCommit).toBe('abc');

    expect(forgejo.openCalls).toHaveLength(1);
    expect(forgejo.openCalls[0]).toMatchObject({
      submissionId: created.id,
      autoApprove: true,
    });
    expect(forgejo.openCalls[0].files.map((file) => file.path).sort()).toEqual([
      'README.md',
      'SKILL.md',
    ]);
    expect(forgejo.mergeCalls).toEqual([1]);
    expect(forgejo.publishCalls).toHaveLength(1);
    expect(forgejo.publishCalls[0]).toMatchObject({
      owner: 'alice',
      name: 'demo-skill',
      version: '1.0.0',
    });
    expect(forgejo.deleteCalls).toEqual(['submit/x']);

    const getRes = await app.request(`/api/v1/submissions/${created.id}`);
    expect(getRes.status).toBe(200);
    const fetched = (await getRes.json()) as Submission;
    expect(fetched.classification).toBe('md-only');
    expect(fetched.status).toMatchObject({ phase: 'published', mergeCommit: 'abc' });

    const workflowRun = getWorkflowRun(db, created.id);
    expect(workflowRun?.serializedContext).not.toBe('{}');
    expect(workflowRun?.context.status).toBe('published');
  });

  it('does not insert skill_versions when the publish status update loses its lock', async () => {
    db = new Database(':memory:');
    runMigrations(db);

    const forgejo = new FakeForgejoClient();
    const dependencies = makeDependencies(forgejo, makeScanReport('pass'));
    const baseAudit = dependencies.audit;
    dependencies.audit = (action, detail) => {
      baseAudit(action, detail);
      if (action === 'submission.created') {
        const updated = updateSubmissionStatus(db!, detail.submissionId as string, 0, {
          statusPhase: 'scanning',
          statusJson: JSON.stringify({ phase: 'scanning', scanJobId: 'concurrent-scan' }),
        });
        expect(updated).toBe(true);
      }
    };
    const app = new Hono<{ Variables: AuthVariables }>();
    app.use('*', async (c, next) => {
      c.set('identity', { sub: 'alice', roles: ['Submitter'] });
      await next();
    });
    app.route(
      '/api/v1/submissions',
      createSubmissionRoutes({
        db,
        forgejo: forgejo as unknown as ForgejoClient,
        workflowDependencies: dependencies,
      }),
    );

    const zipBytes = await buildZip([
      {
        path: 'SKILL.md',
        contents: skillMdFixture({ name: 'stale-lock-skill', version: '1.0.0', author: 'alice' }),
      },
    ]);
    const formData = new FormData();
    formData.set(
      'file',
      new Blob([new Uint8Array(zipBytes)], { type: 'application/zip' }),
      'skill.zip',
    );

    const postRes = await app.request('/api/v1/submissions', {
      method: 'POST',
      body: formData,
    });

    expect(postRes.status).toBe(409);
    await expect(postRes.json()).resolves.toMatchObject({
      error: 'submission_in_progress',
    });
    expect(getSkillVersion(db, 'stale-lock-skill', '1.0.0', 'alice')).toBeUndefined();
    expect(
      db.prepare('SELECT status_phase FROM submissions WHERE id = ?').pluck().get(
        forgejo.openCalls[0].submissionId,
      ),
    ).toBe('scanning');
  });

  it('starts Flowcraft for code-containing submissions and stores the awaiting questionnaire run', async () => {
    db = new Database(':memory:');
    runMigrations(db);

    const forgejo = new FakeForgejoClient();
    const app = new Hono<{ Variables: AuthVariables }>();
    app.use('*', async (c, next) => {
      c.set('identity', { sub: 'alice', roles: ['Submitter'] });
      await next();
    });
    app.route(
      '/api/v1/submissions',
      createSubmissionRoutes({ db, forgejo: forgejo as unknown as ForgejoClient }),
    );

    const zipBytes = await buildZip([
      {
        path: 'SKILL.md',
        contents: skillMdFixture({ name: 'demo-skill', version: '1.0.0', author: 'alice' }),
      },
      { path: 'run.py', contents: 'print("hi")\n' },
    ]);
    const formData = new FormData();
    formData.set(
      'file',
      new Blob([new Uint8Array(zipBytes)], { type: 'application/zip' }),
      'skill.zip',
    );

    const postRes = await app.request('/api/v1/submissions', {
      method: 'POST',
      body: formData,
    });
    expect(postRes.status).toBe(201);
    const created = (await postRes.json()) as { id: string; status: { phase: string } };
    expect(created.status.phase).toBe('questionnaire-pending');
    expect(forgejo.openCalls).toHaveLength(1);
    expect(forgejo.openCalls[0]).toMatchObject({
      submissionId: created.id,
      autoApprove: false,
    });
    expect(forgejo.mergeCalls).toEqual([]);
    expect(forgejo.publishCalls).toHaveLength(0);

    const workflowRun = getWorkflowRun(db, created.id);
    expect(workflowRun?.serializedContext).not.toBe('{}');
    expect(workflowRun?.context._awaitingNodeIds).toEqual(['questionnaire']);

    const getRes = await app.request(`/api/v1/submissions/${created.id}`);
    expect(getRes.status).toBe(200);
    const fetched = (await getRes.json()) as Submission;
    expect(fetched.classification).toBe('code-containing');
    expect(fetched.status).toMatchObject({ phase: 'questionnaire-pending' });
  });

  it('resumes a code-containing submission questionnaire from the SQLite workflow run', async () => {
    db = new Database(':memory:');
    runMigrations(db);

    const forgejo = new FakeForgejoClient();
    const auditCalls: Array<{ action: AuditAction; detail: Record<string, unknown> }> = [];
    const dependencies = makeDependencies(forgejo, makeScanReport('pass'), auditCalls);
    const app = new Hono<{ Variables: AuthVariables }>();
    let identity: Identity = { sub: 'alice-entra-sub', roles: ['Submitter'] };
    app.use('*', async (c, next) => {
      c.set('identity', identity);
      await next();
    });
    app.route(
      '/api/v1/submissions',
      createSubmissionRoutes({
        db,
        forgejo: forgejo as unknown as ForgejoClient,
        workflowDependencies: dependencies,
      }),
    );
    app.route('/api/v1/submissions', createWorkflowRoutes({ db, dependencies }));

    const zipBytes = await buildZip([
      {
        path: 'SKILL.md',
        contents: skillMdFixture({ name: 'demo-skill', version: '1.0.0', author: 'alice' }),
      },
      { path: 'run.py', contents: 'print("hi")\n' },
    ]);
    const formData = new FormData();
    formData.set(
      'file',
      new Blob([new Uint8Array(zipBytes)], { type: 'application/zip' }),
      'skill.zip',
    );

    const createdRes = await app.request('/api/v1/submissions', {
      method: 'POST',
      body: formData,
    });
    const created = (await createdRes.json()) as { id: string };

    const questionnaireRes = await app.request(`/api/v1/submissions/${created.id}/questionnaire`, {
      method: 'POST',
      body: JSON.stringify({ responses: [{ questionId: 'network', answer: false }] }),
      headers: { 'content-type': 'application/json' },
    });

    expect(questionnaireRes.status).toBe(200);
    await expect(questionnaireRes.json()).resolves.toEqual({
      status: { phase: 'user-confirmation-pending' },
    });

    const workflowRun = getWorkflowRun(db, created.id);
    expect(workflowRun?.context.scanReport).toMatchObject({ verdict: 'pass' });
    expect(workflowRun?.context.status).toBe('user-confirmation-pending');
    expect(workflowRun?.submittedBy).toBe('alice-entra-sub');
    expect(auditCalls[0]).toEqual({
      action: 'submission.created',
      detail: {
        actor: 'alice-entra-sub',
        submissionId: created.id,
        skillName: 'demo-skill',
        version: '1.0.0',
      },
    });

    const confirmRes = await app.request(`/api/v1/submissions/${created.id}/confirm`, {
      method: 'POST',
    });
    expect(confirmRes.status).toBe(200);
    await expect(confirmRes.json()).resolves.toEqual({
      status: { phase: 'compliance-review' },
    });

    identity = { sub: 'reviewer-1', roles: ['Compliance'] };
    const approveRes = await app.request(`/api/v1/submissions/${created.id}/approve`, {
      method: 'POST',
    });
    expect(approveRes.status).toBe(200);
    expect(forgejo.mergeCalls).toEqual([1]);
    expect(forgejo.publishCalls).toHaveLength(1);

    const secondApproveRes = await app.request(`/api/v1/submissions/${created.id}/approve`, {
      method: 'POST',
    });
    expect(secondApproveRes.status).toBe(409);
    await expect(secondApproveRes.json()).resolves.toMatchObject({
      error: 'submission_not_in_expected_state',
    });

    const rejectRes = await app.request(`/api/v1/submissions/${created.id}/reject`, {
      method: 'POST',
      body: JSON.stringify({ reason: 'terminal submissions cannot be rejected again' }),
      headers: { 'content-type': 'application/json' },
    });
    expect(rejectRes.status).toBe(409);
    await expect(rejectRes.json()).resolves.toMatchObject({
      error: 'submission_not_in_expected_state',
    });

    identity = { sub: 'alice-entra-sub', roles: ['Submitter'] };
    const confirmResAfterPublish = await app.request(`/api/v1/submissions/${created.id}/confirm`, {
      method: 'POST',
    });
    expect(confirmResAfterPublish.status).toBe(409);
    await expect(confirmResAfterPublish.json()).resolves.toMatchObject({
      error: 'submission_not_in_expected_state',
    });

    const questionnaireResAfterPublish = await app.request(`/api/v1/submissions/${created.id}/questionnaire`, {
      method: 'POST',
      body: JSON.stringify({ responses: [{ questionId: 'network', answer: false }] }),
      headers: { 'content-type': 'application/json' },
    });
    expect(questionnaireResAfterPublish.status).toBe(409);
    await expect(questionnaireResAfterPublish.json()).resolves.toMatchObject({
      error: 'submission_not_in_expected_state',
    });
    expect(forgejo.mergeCalls).toEqual([1]);
    expect(forgejo.publishCalls).toHaveLength(1);

    const versionRow = db
      .prepare('SELECT skill_name, version, approved_by FROM skill_versions WHERE submission_id = ?')
      .get(created.id) as { skill_name: string; version: string; approved_by: string | null } | undefined;
    expect(versionRow).toEqual({
      skill_name: 'demo-skill',
      version: '1.0.0',
      approved_by: 'reviewer-1',
    });
  });

  it('rejects approval when the authenticated submitter is also the Compliance reviewer', async () => {
    db = new Database(':memory:');
    runMigrations(db);

    const forgejo = new FakeForgejoClient();
    const dependencies = makeDependencies(forgejo, makeScanReport('pass'));
    const app = new Hono<{ Variables: AuthVariables }>();
    const identity: Identity = { sub: 'same-principal', roles: ['Submitter', 'Compliance'] };
    app.use('*', async (c, next) => {
      c.set('identity', identity);
      await next();
    });
    app.route(
      '/api/v1/submissions',
      createSubmissionRoutes({
        db,
        forgejo: forgejo as unknown as ForgejoClient,
        workflowDependencies: dependencies,
      }),
    );
    app.route('/api/v1/submissions', createWorkflowRoutes({ db, dependencies }));

    const zipBytes = await buildZip([
      {
        path: 'SKILL.md',
        contents: skillMdFixture({ name: 'demo-skill', version: '1.0.0', author: 'alice' }),
      },
      { path: 'run.py', contents: 'print("hi")\n' },
    ]);
    const formData = new FormData();
    formData.set(
      'file',
      new Blob([new Uint8Array(zipBytes)], { type: 'application/zip' }),
      'skill.zip',
    );

    const createdRes = await app.request('/api/v1/submissions', {
      method: 'POST',
      body: formData,
    });
    expect(createdRes.status).toBe(201);
    const created = (await createdRes.json()) as { id: string };

    await app.request(`/api/v1/submissions/${created.id}/questionnaire`, {
      method: 'POST',
      body: JSON.stringify({ responses: [{ questionId: 'network', answer: false }] }),
      headers: { 'content-type': 'application/json' },
    });
    await app.request(`/api/v1/submissions/${created.id}/confirm`, { method: 'POST' });

    const approveRes = await app.request(`/api/v1/submissions/${created.id}/approve`, {
      method: 'POST',
    });

    expect(approveRes.status).toBe(403);
    await expect(approveRes.json()).resolves.toEqual({
      error: 'separation_of_duties_violation',
    });
    expect(forgejo.mergeCalls).toEqual([]);
    expect(forgejo.publishCalls).toHaveLength(0);
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
  publishCalls: Array<{ owner: string; name: string; version: string; zipBuffer: Buffer }> = [];
  deleteCalls: string[] = [];

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
    return `https://forgejo.example/api/packages/${input.owner}/generic/${input.name}/${input.version}/skill.zip`;
  }

  async deleteBranch(branch: string) {
    this.deleteCalls.push(branch);
  }
}

function makeDependencies(
  forgejo: FakeForgejoClient,
  scanReport: ScanReport,
  auditCalls: Array<{ action: AuditAction; detail: Record<string, unknown> }> = [],
): ApprovalPipelineDependencies {
  return {
    svc(token) {
      if (token === ForgejoClient) {
        return forgejo as never;
      }
      throw new Error('unexpected service token');
    },
    audit(action: AuditAction, detail: Record<string, unknown>) {
      auditCalls.push({ action, detail });
    },
    async runScanner() {
      return scanReport;
    },
  };
}

function makeScanReport(verdict: ScanReport['verdict']): ScanReport {
  return {
    submissionId: 'sub-1',
    scanId: 'scan-1',
    contentHash: 'abc123',
    scannerImage: 'registry.example/asr-scanner:latest',
    startedAt: '2026-05-24T00:00:00.000Z',
    completedAt: '2026-05-24T00:00:01.000Z',
    durationMs: 1000,
    verdict,
    findings: [],
    toolResults: {
      gitleaks: { exitCode: 0, findingCount: 0 },
      trivy: { exitCode: 0, findingCount: 0 },
      foxguard: { exitCode: 0, findingCount: 0 },
      opengrep: { exitCode: 0, findingCount: 0 },
      veracode: { exitCode: 0, findingCount: 0, skipped: true },
    },
  };
}

function skillMdFixture(input: { name: string; version: string; author: string }): string {
  return `---
name: ${input.name}
version: ${input.version}
author: ${input.author}
description: Demo md-only skill for integration testing
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

Hello.
`;
}

async function buildZip(entries: Array<{ path: string; contents: string }>): Promise<Buffer> {
  const zip = new yazl.ZipFile();
  for (const entry of entries) {
    zip.addBuffer(Buffer.from(entry.contents), entry.path);
  }
  zip.end();
  return streamToBuffer(zip.outputStream);
}

async function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as unknown as Uint8Array));
  }
  return Buffer.concat(chunks);
}
