import { serve, type ServerType } from '@hono/node-server';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { SkillManifest, Submission } from '@asr/core';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runMigrations } from '../../src/db/migrations/index.js';
import { insertSkillVersion } from '../../src/db/repositories/skillVersions.js';
import { insertSubmission } from '../../src/db/repositories/submissions.js';
import { saveWorkflowRun } from '../../src/db/repositories/workflowRuns.js';
import type { createApp as CreateApp } from '../../src/index.js';
import type { ReviewDecisionApproveInput, ReviewDecisionRejectInput } from '../../src/mcp/tools/reviewDecision.js';
import type { ApprovalPipelineContext } from '../../src/workflow/approvalPipeline.js';

const SUBMISSION_ID = 'sub-sod';
const OWNER = 'alice';
const SKILL = 'sod-skill';
const VERSION = '1.0.0';
const CONTENT_HASH = 'sha256:sod';
const SUBMITTED_AT = '2026-05-29T00:00:00.000Z';
const AUDIT_HMAC_KEY_B64 = Buffer.alloc(32, 0x42).toString('base64');

describe('cross-cutting separation of duties enforcement', () => {
  let db: Database.Database | undefined;
  let createApp: typeof CreateApp;
  let approveCalls: ReviewDecisionApproveInput[];
  let rejectCalls: ReviewDecisionRejectInput[];

  beforeEach(async () => {
    vi.resetModules();
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('AUTH_MODE', 'mock');
    vi.stubEnv('MOCK_USER_SUB', 'alice');
    vi.stubEnv('MOCK_USER_ROLES', 'Compliance');
    vi.stubEnv('AUDIT_HMAC_KEY_ID', 'k-sod-test');
    vi.stubEnv('AUDIT_HMAC_KEY_BYTES', AUDIT_HMAC_KEY_B64);

    ({ createApp } = await import('../../src/index.js'));

    db = new Database(':memory:');
    runMigrations(db);
    seedSubmissionAndVersion(db);
    approveCalls = [];
    rejectCalls = [];
  });

  afterEach(() => {
    db?.close();
    db = undefined;
    vi.unstubAllEnvs();
  });

  it.each([
    {
      label: 'submission approval endpoint',
      path: `/api/v1/submissions/${SUBMISSION_ID}/approve`,
      body: {},
    },
    {
      label: 'submission rejection endpoint',
      path: `/api/v1/submissions/${SUBMISSION_ID}/reject`,
      body: { reason: 'same submitter cannot reject this submission' },
    },
    {
      label: 'version yank endpoint',
      path: `/api/v1/skills/${OWNER}/${SKILL}/versions/${VERSION}/yank`,
      body: { reason: 'same publisher cannot yank this version', severity: 'high' },
    },
  ])('returns 403 separation_of_duties_violation from $label', async ({ path, body }) => {
    const app = createTestApp();

    const res = await app.request(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toMatchObject({
      error: 'separation_of_duties_violation',
    });
  });

  it('returns a separation_of_duties_violation MCP tool result for review_decision', async () => {
    const app = createTestApp();
    const server = await serveApp(app);
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('expected test server to bind to an ephemeral port');
    }

    const client = new Client(
      { name: 'asr-sod-cross-cutting-test', version: '0.0.0' },
      { capabilities: {} },
    );
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${address.port}/mcp`),
    );

    try {
      await client.connect(transport);
      const result = await client.callTool({
        name: 'review_decision',
        arguments: { submissionId: SUBMISSION_ID, decision: 'approve' },
      });

      expect(result.isError).toBe(true);
      expect(result.content).toEqual([
        { type: 'text', text: 'separation_of_duties_violation' },
      ]);
      expect(approveCalls).toEqual([]);
      expect(rejectCalls).toEqual([]);
    } finally {
      await client.close();
      await closeServer(server);
    }
  });

  function createTestApp() {
    return createApp({
      workflow: { db: db!, now: fixedNow },
      yank: {
        db: db!,
        forgejo: new FakeForgejoClient() as never,
      },
      mcp: {
        db: db!,
        reviewDecisionDeps: {
          deliverReviewApproval(input) {
            approveCalls.push(input);
            return {
              publishedAt: '2026-05-29T01:00:00.000Z',
              mergeCommit: 'merge-sod',
            };
          },
          deliverReviewRejection(input) {
            rejectCalls.push(input);
            return { rejectedAt: '2026-05-29T02:00:00.000Z' };
          },
        },
      },
    });
  }
});

function seedSubmissionAndVersion(db: Database.Database): void {
  const manifest = makeManifest();
  const submission: Submission = {
    id: SUBMISSION_ID,
    manifest,
    classification: 'md-only',
    contentHash: CONTENT_HASH,
    submittedAt: SUBMITTED_AT,
    submittedBy: 'alice',
    status: { phase: 'compliance-review' },
  };

  insertSubmission(db, {
    id: submission.id,
    manifestJson: JSON.stringify(manifest),
    classification: submission.classification,
    contentHash: submission.contentHash,
    submittedAt: submission.submittedAt,
    submittedBy: submission.submittedBy,
    statusPhase: submission.status.phase,
    statusJson: JSON.stringify(submission.status),
  });

  const context: ApprovalPipelineContext = {
    submissionId: submission.id,
    submission,
    manifest,
    files: [{ path: 'SKILL.md', contentBase64: Buffer.from('# sod').toString('base64') }],
    contentHash: submission.contentHash,
    extractedDir: '/tmp/sub-sod',
    zipBufferBase64: Buffer.from('zip').toString('base64'),
    status: 'compliance-review',
  };
  saveWorkflowRun(db, {
    id: submission.id,
    submittedBy: submission.submittedBy,
    serializedContext: JSON.stringify({ waiting: 'review' }),
    context,
  }, fixedNow());

  insertSkillVersion(db, {
    skill_name: SKILL,
    version: VERSION,
    content_hash: CONTENT_HASH,
    submission_id: submission.id,
    published_at: '2026-05-29T00:30:00.000Z',
    published_by: 'alice',
    approved_by: 'alice',
    pr_number: 7,
    merge_commit: 'merge-prior',
    scan_report_id: null,
    yanked_at: null,
    yanked_by: null,
    yank_reason: null,
  });
}

function makeManifest(): SkillManifest {
  return {
    name: SKILL,
    version: VERSION,
    author: OWNER,
    description: 'Skill used to verify separation of duties checks',
    tags: ['security'],
    kind: 'skill',
    permissions: {
      network: false,
      filesystem: 'none',
      subprocess: false,
      environment: [],
    },
  };
}

class FakeForgejoClient {
  async commitFileToMain(): Promise<{ sha: string }> {
    throw new Error('Forgejo should not be called when SoD blocks the yank');
  }
}

function fixedNow(): Date {
  return new Date('2026-05-29T00:00:00.000Z');
}

async function serveApp(app: ReturnType<typeof createApp>): Promise<ServerType> {
  return new Promise<ServerType>((resolve) => {
    const server = serve({ fetch: app.fetch, port: 0 }, () => resolve(server));
  });
}

async function closeServer(server: ServerType): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}
