import type { SkillManifest, Submission } from '@asr/core';
import Database from 'better-sqlite3';
import { pino } from 'pino';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { createApp as CreateApp } from '../index.js';
import { runMigrations } from '../db/migrations/index.js';
import { insertSubmission } from '../db/repositories/submissions.js';
import { MCP_ERROR, McpToolError } from './errors.js';
import { createRateLimiter } from './rateLimit.js';
import {
  MCP_PROTOCOL_VERSION,
  clearMcpSessionsForTest,
  wrapToolHandler,
  type WrapToolHandlerDeps,
} from './server.js';
import type { InvocationLogger } from './telemetry.js';

let createApp: typeof CreateApp;
let db: Database.Database | undefined;

function makeManifest(name: string, version = '1.0.0'): SkillManifest {
  return {
    name,
    version,
    author: 'submitter@example.com',
    description: `${name} skill awaiting review`,
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

function seedReviewSubmission(
  database: Database.Database,
  id: string,
  manifest: SkillManifest,
): Submission {
  const submission: Submission = {
    id,
    manifest,
    classification: 'md-only',
    contentHash: `sha256:${id}`,
    submittedAt: '2026-05-24T10:00:00.000Z',
    submittedBy: 'submitter@example.com',
    status: { phase: 'compliance-review' },
  };
  insertSubmission(database, {
    id: submission.id,
    manifestJson: JSON.stringify(submission.manifest),
    classification: submission.classification,
    contentHash: submission.contentHash,
    submittedAt: submission.submittedAt,
    submittedBy: submission.submittedBy,
    statusPhase: submission.status.phase,
    statusJson: JSON.stringify(submission.status),
  });
  return submission;
}

function makeCapturingLogger(): {
  logger: InvocationLogger;
  records: Record<string, unknown>[];
} {
  const records: Record<string, unknown>[] = [];
  const logger = pino(
    { level: 'info' },
    {
      write(chunk: string) {
        records.push(JSON.parse(chunk));
      },
    },
  );
  return { logger, records };
}

function makeDeps(overrides: Partial<WrapToolHandlerDeps> = {}): {
  deps: WrapToolHandlerDeps;
  records: Record<string, unknown>[];
} {
  const { logger, records } = makeCapturingLogger();
  const deps: WrapToolHandlerDeps = {
    limiter: createRateLimiter(),
    logger,
    principalOf: () => 'sub-test',
    sessionOf: () => 'sess-test',
    ...overrides,
  };
  return { deps, records };
}

beforeAll(async () => {
  vi.stubEnv('NODE_ENV', 'development');
  vi.stubEnv('AUTH_MODE', 'mock');
  vi.stubEnv('MOCK_USER_SUB', 'mock-user');
  vi.stubEnv('MOCK_USER_ROLES', 'Submitter');

  ({ createApp } = await import('../index.js'));
});

afterEach(() => {
  clearMcpSessionsForTest();
  db?.close();
  db = undefined;
  vi.stubEnv('AUTH_MODE', 'mock');
  vi.stubEnv('MOCK_USER_SUB', 'mock-user');
  vi.stubEnv('MOCK_USER_ROLES', 'Submitter');
});

describe('mcpHandler', () => {
  it('initializes a Streamable HTTP MCP session', async () => {
    const app = createApp();
    const res = await initializeMcpSession(app);

    expect(res.status).toBe(200);
    expect(res.headers.get('mcp-session-id')).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    await expect(res.json()).resolves.toMatchObject({
      jsonrpc: '2.0',
      id: 1,
      result: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        serverInfo: { name: 'asr-registry', version: '0.1.0' },
      },
    });
  });

  it('opens a GET SSE stream for an initialized session', async () => {
    const app = createApp();
    const init = await initializeMcpSession(app);
    const sessionId = init.headers.get('mcp-session-id');

    expect(sessionId).toBeTruthy();

    const res = await app.request('/mcp', {
      method: 'GET',
      headers: {
        accept: 'text/event-stream',
        'mcp-session-id': sessionId ?? '',
      },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    await res.body?.cancel();
  });

  it('returns not found for a GET with an unknown session id', async () => {
    const app = createApp();
    const res = await app.request('/mcp', {
      method: 'GET',
      headers: {
        accept: 'text/event-stream',
        'mcp-session-id': 'missing-session',
      },
    });

    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toMatchObject({
      jsonrpc: '2.0',
      error: { message: 'MCP session not found' },
    });
  });

  it('tears down a session with DELETE', async () => {
    const app = createApp();
    const init = await initializeMcpSession(app);
    const sessionId = init.headers.get('mcp-session-id');

    expect(sessionId).toBeTruthy();

    const deleted = await app.request('/mcp', {
      method: 'DELETE',
      headers: {
        'mcp-session-id': sessionId ?? '',
      },
    });

    expect(deleted.status).toBe(200);

    const res = await app.request('/mcp', {
      method: 'GET',
      headers: {
        accept: 'text/event-stream',
        'mcp-session-id': sessionId ?? '',
      },
    });

    expect(res.status).toBe(404);
  });

  it('rejects an initialize with no bearer in entra mode (-32002, no session)', async () => {
    vi.stubEnv('AUTH_MODE', 'entra');
    try {
      const app = createApp();
      const res = await initializeMcpSession(app);

      expect(res.headers.get('mcp-session-id')).toBeNull();
      await expect(res.json()).resolves.toMatchObject({
        jsonrpc: '2.0',
        id: 1,
        error: { code: -32002, message: 'authentication_required' },
      });
    } finally {
      vi.stubEnv('AUTH_MODE', 'mock');
    }
  });

  it('binds the mock Submitter principal and serves tools/list on follow-up', async () => {
    const app = createApp();
    const init = await initializeMcpSession(app);
    const sessionId = init.headers.get('mcp-session-id');

    expect(init.status).toBe(200);
    expect(sessionId).toBeTruthy();

    const res = await app.request('/mcp', {
      method: 'POST',
      headers: {
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
        'mcp-session-id': sessionId ?? '',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/list',
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      jsonrpc: '2.0',
      id: 2,
      result: { tools: expect.any(Array) },
    });
  });

  it('rejects follow-up requests once the MCP session absolute lifetime expires', async () => {
    let now = 1_000;
    const app = createApp({
      mcp: {
        session: {
          idleTimeoutMs: 10_000,
          maxAgeMs: 100,
          now: () => now,
          sweepIntervalMs: 0,
        },
      },
    });
    const init = await initializeMcpSession(app);
    const sessionId = init.headers.get('mcp-session-id');

    expect(init.status).toBe(200);
    expect(sessionId).toBeTruthy();

    now += 101;
    const res = await app.request('/mcp', {
      method: 'POST',
      headers: {
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
        'mcp-session-id': sessionId ?? '',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/list',
      }),
    });

    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toMatchObject({
      jsonrpc: '2.0',
      id: 2,
      error: { code: MCP_ERROR.authentication_required, message: 'authentication_required' },
    });

    const retry = await app.request('/mcp', {
      method: 'POST',
      headers: {
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
        'mcp-session-id': sessionId ?? '',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/list',
      }),
    });
    expect(retry.status).toBe(404);
  });

  it('rejects idle MCP sessions and removes least-recently-used sessions over the cap', async () => {
    let now = 10_000;
    const app = createApp({
      mcp: {
        session: {
          idleTimeoutMs: 50,
          maxAgeMs: 10_000,
          maxSessions: 1,
          now: () => now,
          sweepIntervalMs: 0,
        },
      },
    });
    const first = await initializeMcpSession(app);
    const firstSessionId = first.headers.get('mcp-session-id');
    expect(firstSessionId).toBeTruthy();

    now += 10;
    const second = await initializeMcpSession(app);
    const secondSessionId = second.headers.get('mcp-session-id');
    expect(secondSessionId).toBeTruthy();

    const capped = await app.request('/mcp', {
      method: 'GET',
      headers: {
        accept: 'text/event-stream',
        'mcp-session-id': firstSessionId ?? '',
      },
    });
    expect(capped.status).toBe(404);

    now += 51;
    const idle = await app.request('/mcp', {
      method: 'GET',
      headers: {
        accept: 'text/event-stream',
        'mcp-session-id': secondSessionId ?? '',
      },
    });
    expect(idle.status).toBe(401);
    await expect(idle.json()).resolves.toMatchObject({
      jsonrpc: '2.0',
      error: { code: MCP_ERROR.authentication_required, message: 'authentication_required' },
    });
  });

  it('lets a Compliance-only mock principal initialize and call review_queue', async () => {
    vi.stubEnv('MOCK_USER_SUB', 'reviewer-1');
    vi.stubEnv('MOCK_USER_ROLES', 'Compliance');

    db = new Database(':memory:');
    runMigrations(db);
    seedReviewSubmission(db, 'sub-pending-1', makeManifest('alpha'));

    const app = createApp({ mcp: { db } });
    const init = await initializeMcpSession(app);
    const sessionId = init.headers.get('mcp-session-id');

    expect(init.status).toBe(200);
    expect(sessionId).toBeTruthy();

    const res = await app.request('/mcp', {
      method: 'POST',
      headers: {
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
        'mcp-session-id': sessionId ?? '',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'review_queue',
          arguments: { limit: 20 },
        },
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      jsonrpc: '2.0',
      id: 2,
      result: {
        structuredContent: {
          submissions: [expect.objectContaining({ id: 'sub-pending-1' })],
        },
      },
    });
  });
});

describe('wrapToolHandler', () => {
  it('blocks the 601st read invocation for a single principal with a -32005 McpToolError', async () => {
    let now = 0;
    const limiter = createRateLimiter(() => now);
    const { deps } = makeDeps({ limiter });
    const wrapped = wrapToolHandler(
      'registry_search',
      async (_extra: unknown) => ({ content: [] }),
      deps,
    );

    for (let i = 0; i < 600; i++) {
      await wrapped({});
    }

    let caught: unknown;
    try {
      await wrapped({});
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(McpToolError);
    const err = caught as McpToolError;
    expect(err.code).toBe(MCP_ERROR.rate_limited);
    expect(err.code).toBe(-32005);
    const retryAfter = (err.data as { retryAfterSeconds?: unknown } | undefined)
      ?.retryAfterSeconds;
    expect(typeof retryAfter).toBe('number');
    expect(retryAfter as number).toBeGreaterThanOrEqual(1);
    expect(retryAfter as number).toBeLessThanOrEqual(60);
  });

  it('rejects BEFORE the handler runs when rate-limited', async () => {
    let now = 0;
    const limiter = createRateLimiter(() => now);
    const { deps } = makeDeps({ limiter });
    let calls = 0;
    const wrapped = wrapToolHandler(
      'review_decision',
      async (_extra: unknown) => {
        calls += 1;
        return { ok: true };
      },
      deps,
    );

    for (let i = 0; i < 60; i++) {
      await wrapped({});
    }
    expect(calls).toBe(60);

    await expect(wrapped({})).rejects.toBeInstanceOf(McpToolError);
    expect(calls).toBe(60);
  });

  it('emits exactly the six telemetry fields on a successful invocation', async () => {
    const { deps, records } = makeDeps({
      principalOf: () => 'sub-123',
      sessionOf: () => 'sess-abc',
    });
    const wrapped = wrapToolHandler(
      'registry_search',
      async (_extra: unknown) => ({ content: [{ type: 'text', text: 'secret-payload' }] }),
      deps,
    );

    await wrapped({});

    expect(records).toHaveLength(1);
    const record = records[0]!;
    const payloadKeys = Object.keys(record).filter(
      (k) => !['level', 'time', 'pid', 'hostname', 'name', 'v', 'msg'].includes(k),
    );
    expect(new Set(payloadKeys)).toEqual(
      new Set(['traceId', 'sessionId', 'principalSub', 'tool', 'durationMs', 'outcome']),
    );
    expect(record.outcome).toBe('ok');
    expect(record.tool).toBe('registry_search');
    expect(record.principalSub).toBe('sub-123');
    expect(record.sessionId).toBe('sess-abc');
    expect(typeof record.traceId).toBe('string');
    expect(typeof record.durationMs).toBe('number');
    for (const forbidden of ['input', 'output', 'result', 'args', 'arguments', 'content']) {
      expect(record).not.toHaveProperty(forbidden);
    }
  });

  it('records outcome=error with code from McpToolError in the finally block', async () => {
    const { deps, records } = makeDeps();
    const wrapped = wrapToolHandler(
      'registry_info',
      async (_extra: unknown) => {
        throw new McpToolError(MCP_ERROR.resource_not_found, 'resource_not_found');
      },
      deps,
    );

    await expect(wrapped({})).rejects.toBeInstanceOf(McpToolError);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      outcome: 'error',
      code: MCP_ERROR.resource_not_found,
      tool: 'registry_info',
    });
  });

  it('logs the rate-limit rejection with outcome=error code=-32005 durationMs=0', async () => {
    let now = 0;
    const limiter = createRateLimiter(() => now);
    const { deps, records } = makeDeps({ limiter });
    const wrapped = wrapToolHandler(
      'review_decision',
      async (_extra: unknown) => ({ ok: true }),
      deps,
    );

    for (let i = 0; i < 60; i++) {
      await wrapped({});
    }
    await expect(wrapped({})).rejects.toBeInstanceOf(McpToolError);

    const last = records[records.length - 1]!;
    expect(last.outcome).toBe('error');
    expect(last.code).toBe(MCP_ERROR.rate_limited);
    expect(last.tool).toBe('review_decision');
    expect(last.durationMs).toBe(0);
  });

  it('resolves principalSub/sessionId from the extra arg passed to the tool callback', async () => {
    const seen: Array<{ p: string; s: string }> = [];
    const deps: WrapToolHandlerDeps = {
      limiter: createRateLimiter(),
      logger: makeCapturingLogger().logger,
      principalOf: (extra) => {
        const auth = (extra as { authInfo?: { extra?: { principal?: { sub?: string } } } })
          .authInfo;
        const sub = auth?.extra?.principal?.sub ?? '';
        seen.push({ p: sub, s: (extra as { sessionId?: string }).sessionId ?? '' });
        return sub;
      },
      sessionOf: (extra) => (extra as { sessionId?: string }).sessionId ?? '',
    };

    const wrapped = wrapToolHandler(
      'registry_search',
      async (_extra: unknown) => ({}),
      deps,
    );
    await wrapped({
      authInfo: { extra: { principal: { sub: 'caller-9' } } },
      sessionId: 'sess-9',
    });

    expect(seen).toEqual([{ p: 'caller-9', s: 'sess-9' }]);
  });
});

async function initializeMcpSession(app: ReturnType<typeof createApp>): Promise<Response> {
  return await app.request('/mcp', {
    method: 'POST',
    headers: {
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'asr-test', version: '0.0.0' },
      },
    }),
  });
}
