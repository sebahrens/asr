import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { createApp as CreateApp } from '../index.js';
import { MCP_PROTOCOL_VERSION } from './server.js';

let createApp: typeof CreateApp;

beforeAll(async () => {
  vi.stubEnv('NODE_ENV', 'development');
  vi.stubEnv('AUTH_MODE', 'mock');
  vi.stubEnv('MOCK_USER_SUB', 'mock-user');
  vi.stubEnv('MOCK_USER_ROLES', 'Submitter');

  ({ createApp } = await import('../index.js'));
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
